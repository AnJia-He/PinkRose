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
import { ZERO, type Adjustments } from '../shared/adjustments.ts'
import { MAX_LUT_FILE_BYTES, type LutMeta } from '../shared/lut.ts'
import type {
  SessionDetail, SessionMessage, SessionMeta, SessionStep,
} from '../shared/sessions.ts'

// ── 假扮：这些是浏览器能力，jsdom 里没有 ──────────────────────────────
// 原则是"只换掉必要的那一个，其余保留真的"，免得把要测的东西一起假掉。

/** 送到画布上的到底是哪一张 —— 「缩过的那张有没有真的被用上」只能这样看。
 *  用 hoisted：vi.mock 的工厂会被提到所有 import 之前执行。 */
const canvasProps = vi.hoisted(() => ({
  images: [] as { width: number; height: number }[],
  // ★ 2026-10-06：`busy` 是"生成中照片上那层暗罩"的唯一依据（真的 Canvas 按它
  //   渲染 `.canvas-veil`）—— 这个假画布看不到暗罩本身，就只能看它拿到的 prop。
  //   ★ 2026-10-06（工具行）：`viewLocked` 同理 —— 工具开着时的手势停用
  //   （滚轮 / 拖动 / 双击不响应、右下角那排按钮不画）**那一半量在真画布那边**
  //   （`Canvas.zoom.test.tsx` 里量真的 DOM），这儿只钉 App 有没有把它送出去。
  props: [] as { originalPreview: string | null; picking: boolean; marker: unknown
                  params: Record<string, number>; busy: boolean; viewLocked: boolean
                  // ★ 2026-10-06（裁剪）：`crop` 是"框 + 预览那一帧"的现场 ——
                  //   真画布按它转照片、摆框（那两条量在 `Canvas.zoom.test.tsx`
                  //   里），这一层只钉 App 有没有把现场交下去。
                  crop: unknown
                  // ★ 2026-10-06（对比）：开关 / 备好的原图 / 那颗按钮的回调，
                  //   外加 `resetKey`（"对比不算工具开着"那条要钉住它**不因它变**）。
                  comparing: boolean; compareWith: string | null; resetKey: unknown
                  onCompare: (() => void) | undefined }[],
}))

/** 画布：真的那个要 WebGL2。这里给一个真 <canvas> 并挂上 ref ——
 *  `send` 的守卫要求 canvasRef.current 非空，假成 null 的话一句都发不出去。 */
vi.mock('./ui/Canvas', async () => {
  const React = await import('react')
  return {
    default: ({ canvasRef, image, params, originalPreview, picking, marker, onPickPoint, busy, viewLocked, crop, comparing, compareWith, resetKey, onCompare }: any) => {
      canvasProps.images.push(image)
      canvasProps.props.push({
        originalPreview, picking, marker, params, busy, viewLocked, crop,
        comparing, compareWith, resetKey, onCompare,
      })
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

/** ★ 2026-10-06（裁剪）：**整个假掉** —— `cropToBitmap` 要真 2D 上下文 +
 *  `createImageBitmap`，jsdom 两样都没有。这一层要验的只是**接线**
 *  （推了步、参数没动、光标挪了、能回去）；像素对不对是 Task 6 真机的事。
 *  假实现返回一张带记号的小位图，"送进去的是哪张、换上来的是哪张"都看得见。 */
vi.mock('./image/crop', () => ({ cropToBitmap: vi.fn() }))

/** 解码用户选的文件：要 createImageBitmap + 2D 画布。
 *  用 importOriginal 保留它的转发导出（size 那几个），因为别处会 import。 */
vi.mock('./image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image/decode')>()
  return { ...actual, decodeImageFile: vi.fn() }
})

/** 「照着这张调」那一步要读像素（源图、参考图各采一遍），要 2D 画布，jsdom 没有。
 *  ⚠️ 假掉的**只有"读像素"这一下**：`samplePixels` 拿到什么内容由各用例自己给，
 *  而 `matchToReference` 本身**真的跑** —— 合流语义正是它和 `setParams` 交界处的
 *  事，假掉拟合就等于把要测的东西一起假掉了。 */
vi.mock('./image/sample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image/sample')>()
  return { ...actual, samplePixels: vi.fn() }
})

/** 三个网络出口。**保留真的 ApiError** —— App 里靠 `instanceof ApiError`
 *  决定给用户看哪句话，假掉它就把错误路径一起假掉了。 */
vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return { ...actual, postRoute: vi.fn(), postSuggest: vi.fn(), postEdit: vi.fn() }
})

// ── 假扮：滤镜那两条网络 + 缩略图渲染器（要 2D 画布）─────────────────
/**
 * 一个 **2 级恒等 cube** 的原文（`LUT_3D_SIZE 2` 的 8 个格子，红变最快）。
 * 解析出来等于"什么都不改"，所以拿它当"服务端上那个滤镜的文件"最省事。
 *
 * ⚠️ 必须走 `vi.hoisted`：`vi.mock` 的工厂会被提到**所有 import 之前**执行，
 * 而工厂里就要用这个串 —— 直接写一个顶层 `const` 的话，工厂跑的时候它还在
 * TDZ 里（`Cannot access 'CUBE2_TEXT' before initialization`）。
 * 文件里 `canvasProps` 用的是同一个路数。
 */
const CUBE2_TEXT = vi.hoisted(() => [
  'LUT_3D_SIZE 2',
  '0 0 0', '1 0 0', '0 1 0', '1 1 0',
  '0 0 1', '1 0 1', '0 1 1', '1 1 1',
].join('\n'))

/** 缩略图渲染器：jsdom 里 `getContext('2d')` 回 null，真跑会抛。
 *  假成"每张图一个固定的 dataURL"，断言只关心**格子有没有图**。 */
vi.mock('./render/lutPreview', () => ({
  createLutPreview: () => ({
    setImage: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockReturnValue('data:,thumb'),
    dispose: vi.fn(),
  }),
}))
/** 滤镜那两条网络。**默认**给一条「黄昏」+ 一份能解析的 cube 文本 ——
 *  各用例要"清单里没有它"的样子，自己在用例里盖 `mockResolvedValue`。
 *  ⚠️ 这两条**必须**接住：掉进那个兜底的 blob 形状的话，`listLuts` 每挂一次
 *  App 就往控制台刷一行「滤镜清单没取回来」—— 噪声会盖住真话（和会话列表同一条理由）。 */
vi.mock('./api/luts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/luts')>()
  return {
    ...actual,
    listLuts: vi.fn().mockResolvedValue({ luts: [{ id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }] }),
    lutFileText: vi.fn().mockResolvedValue(CUBE2_TEXT),
    createLut: vi.fn(), renameLut: vi.fn(), deleteLut: vi.fn(), lutUsage: vi.fn(),
  }
})

import App from './App'
import { PRESETS } from './core/presets'
import { MIN_SLICE_RATIO, formatSize, modelValue, pie3dPaths } from './ui/AccountPage'
import type { PublicConfig } from './api/models'
import { matchToReference, type Rgb } from './core/colorMatch'
import * as decodeMod from './image/decode'
import * as prepareMod from './image/prepare'
import * as api from './api/client'
import * as limitsMod from './render/limits'
import * as resizeMod from './image/resize'
import * as saveMod from './export/save'
import * as thumbMod from './core/thumbnail'
import * as markMod from './image/mark'
import * as cropMod from './image/crop'
import * as sampleMod from './image/sample'
import * as lutsMod from './api/luts'

// ── 每张"底"带一个记号，好认出送上去的到底是哪一张 ──────────────────
let bitmapSeq = 0
function fakeBitmap(tag: string) {
  return { width: 1200, height: 800, close: vi.fn(), __tag: tag } as unknown as ImageBitmap
}
/**
 * `fetch(某张图) → createImageBitmap` 那条路**解出来的**位图，按解出来的顺序攒着。
 *
 * 为什么要单独记一份：`vi.mocked(createImageBitmap).mock.results` 里拿到的是
 * **Promise**（这个 stub 是 async 的），要自己拆；而这条线上真正要问的问题是
 * "**同一个位图对象被关了几次**"（见「恢复还在路上」那条用例的第 ④ 条），
 * 直接拿着对象问最省事，也不会因为将来 stub 换成非 async 而失效。
 */
const decodedBitmaps: ImageBitmap[] = []
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
/**
 * ★ 2026-10-04：`/api/me` 现在还会带 `usage`（作品张数 / 占的空间 / 上限）——
 * 用户管理页的「使用情况」那一格吃的就是它（数据源从"前端拉整份作品清单自己加"
 * 换成了这个，因为那边**把会话占的空间也算进去了**）。
 * `null` = 这一版响应里没有 usage（老后端 / 半坏的响应）。
 */
let meUsage: { count: number; bytes: number; limit: number } | null = null
/** 数过几次 `/api/me` —— 用户管理页挂载时那一次要能单独认出来（挂住它用）。 */
let meCalls = 0
/** 把**用户管理页那一次**（第 2 次起的）`/api/me` 挂住不回，演"用量还在路上"。 */
let meUsageGate: { promise: Promise<void>; open: () => void } | null = null
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

/** 服务端上那条滤镜（`vi.mock('./api/luts')` 的默认清单就是它）。
 *  ★ 2026-10-05（T12）：作品配方里只存滤镜的**名字**，「套到别的图上」凭它找回 id。 */
const HUANGHUN: LutMeta = { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }

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

/** ★ 2026-10-04：用户管理页的「使用情况」现在吃 `/api/me` 的 `usage`
 *  （那边把**会话**占的空间也算进去了）。这一组给它盖上真数；上限默认 5 GB。 */
function withUsage(u: { count: number; bytes: number }) {
  meUsage = { limit: 5 * 1024 ** 3, ...u }
}

/** 用户管理页那一次用量请求失败（500 + 一句服务端的话，用 sentinel 认领它）。 */
function withUsageError(message: string) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    // 开机那次（meCalls 还是 0）照常放行，只坏"用户管理页问用量"那一次
    if (url === '/api/me' && meCalls >= 1) {
      return jsonResponse({ error: { code: 'INTERNAL', message } }, 500)
    }
    return inner(url, init)
  })
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
    // ★ 2026-10-05（滤镜 T11）：`RouteDecision.lut` 是**必填** —— 新增字段就该
    //   逼着所有构造点表态，这份默认值就是"这次不碰滤镜"的表态。
    lut: null,
    ...over,
  }
}

// ── 「造一条真会话」的三件套 ─────────────────────────────────────────
// ★ 2026-10-05（滤镜 T8）从「恢复」那个 describe 里**整段挪到这儿**的
//   （原文照搬，注释一条没丢）—— 理由和上面 `WORK` 那条一模一样：
//   滤镜那组也要"让 GET /api/sessions 回一条真会话"，**造两份**的话哪天
//   服务端的形状变了，只会有一份跟着改。

/** 一条会话的元数据。`updatedAt` 决定它在列表里排第几（服务端按它倒序给）。 */
const SMETA = (id: number, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id, title: null, originalName: '古镇.jpg', createdAt: 0, updatedAt: id * 100,
  hasThumb: true, stepCount: 1, ...over,
})

/**
 * 造一条 n 步的会话。
 *
 * ⚠️ **id 走真挂载会长出来的那个序列**（2026-10-01 评审后改的，原来是
 * `id*100+i` 那种"永远不会撞"的号）：欢迎语 = 1，而它同时就是第 1 步的 id
 * （`onPick` 里那个 `say()` 拿到的号给了消息和快照两边）；之后每一步吃掉
 * 两个号（用户那条 + 助手那条），助手那条 = 这一步的 id。所以步骤 id 是
 * 1、3、5…，最后一条用户消息接着往下走。
 *
 * ⚠️ 为什么**必须**是这样：真会话的号就在 1、2、3 这一段（每个会话各自从 1
 * 开始，服务端原样存回来）。用 700 这种号造，就永远测不出"恢复之后本地那个
 * 计数器有没有跟着跳过去"—— 而那正是「接着说话不许撞号」那条用例要盯的事。
 *
 * `tag` 只用来让两条会话的助手消息**一眼分得开**（"上一条的话跟过来没有"）。
 */
function makeSession(
  id: number, n: number, words: string, tag: string,
): SessionDetail {
  const steps: SessionStep[] = []
  const messages: SessionMessage[] = []
  for (let i = 0; i < n; i++) {
    const sid = 2 * i + 1
    steps.push({
      id: sid,
      label: i === 0 ? '原图' : '生成式编辑',
      params: { ...ZERO, exposure: i },
      at: 0,
      // 第 2 步和第 1 步**用的是同一张图**（`reusesPrev`）—— 恢复时它该省一次下载
      reusesPrev: i === 1,
      ...(i === 0 ? {} : { prompt: `make it step ${i}` }),
    })
    if (i > 0) messages.push({ id: sid - 1, role: 'user', text: `make it step ${i}`, at: 0 })
    messages.push({ id: sid, role: 'assistant', text: `${tag}第 ${i} 步`, at: 0 })
  }
  messages.push({ id: 2 * n, role: 'user', text: words, at: 0 })
  return { ...SMETA(id, { stepCount: n }), messages, steps }
}

/** 盖上一整条会话的路：列表、详情、原图、每一步的图。只加不改。
 *
 *  返回的 `serve` 用来演"换一条会话"（重开一次页面时服务端那边最近动过的
 *  已经换成另一条了）—— 今天"切到另一条"的现实形态就是这个，会话列表由
 *  Task 6 做。 */
function withSessions(initial: SessionDetail[], opts: { originalFails?: boolean } = {}) {
  let rows = [...initial]
  const stepGets: string[] = []
  let originalGets = 0
  let listGets = 0
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/sessions' && method === 'GET') {
      // 服务端按 `updated_at` 倒序给（§5）—— 最上面那条就是"上次动过的"
      listGets++
      return jsonResponse({ sessions: [...rows].sort((a, b) => b.updatedAt - a.updatedAt) })
    }
    const one = /^\/api\/sessions\/(\d+)$/.exec(url)
    if (one && method === 'GET') {
      const d = rows.find(x => x.id === Number(one[1]))
      if (!d) return jsonResponse({ error: { code: 'NOT_FOUND', message: '没有这条' } }, 404)
      return jsonResponse(d)
    }
    // 删一条（Task 6 的列表上那颗「删掉」）。**必须接住**：掉进下面那个兜底的
    // blob 形状的话，`deleteSession` 读正文那一步会炸 —— 而"删失败了"这条路上
    // App 那边什么都不做，测试于是绿在一个**报错的路径**上。
    if (one && method === 'DELETE') {
      rows = rows.filter(x => x.id !== Number(one[1]))
      return jsonResponse({ ok: true })
    }
    if (/^\/api\/sessions\/\d+\/file\/original$/.test(url)) {
      originalGets++
      // `originalFails` 演的是"原图这一趟取不回来"（文件没了、网断了）。
      // 形状故意跟另外几条一样：**请求回来了、读正文时炸** —— App 那边就是
      // `(await fetch(...)).blob()` 抛出去，走进那个 catch。
      if (opts.originalFails) return { blob: async () => { throw new Error('原图取不回来') } }
      return { blob: async () => new Blob(['ORIGINAL'], { type: 'image/jpeg' }) }
    }
    if (/^\/api\/sessions\/\d+\/file\/step\/\d+$/.test(url)) {
      stepGets.push(url)
      return { blob: async () => new Blob([url], { type: 'image/jpeg' }) }
    }
    return inner(url, init)
  })
  return {
    stepGets,
    originalCount: () => originalGets,
    listCount: () => listGets,
    serve: (next: SessionDetail[]) => { rows = [...next] },
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
  decodedBitmaps.length = 0
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
  // ★ 2026-10-06（裁剪）：「完成」裁出来的那一张。真实现要 2D 上下文，整个假掉
  //   （见顶上那个 `vi.mock`）—— 记号是 `cropped`，断言里一眼分得开
  //   （送进去的是 `upload`，回来的是 `cropped`）。
  vi.mocked(cropMod.cropToBitmap).mockResolvedValue(fakeBitmap('cropped'))
  // 「照着这张调」的两个采样点：jsdom 里读不了像素，默认给一块中性灰。
  // 只有照调那条用例会覆盖它（覆盖成"源图和参考图分得开"的假数据 ——
  // 拟合要真的算出一个不为零的结果）。
  vi.mocked(sampleMod.samplePixels).mockReturnValue([[128, 128, 128]])
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
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const b = fakeBitmap(`decoded-${++bitmapSeq}`)
    decodedBitmaps.push(b)
    return b
  }))
  // ★ 2026-09-25（Task 7）加：开页那一次 `/api/me` 要回一个**登录着的人**——
  //   这一整个文件测的是修图那条线，它的前提就是"已经登录"（后端现在只认
  //   登录过的人，不认就直接 401）。要测登录页本身的那几条把 `meUser` 置空。
  meUser = LOGGED_IN
  meFails = false
  meGate = null
  // ★ 2026-10-04：用量默认"什么都没存"（0 张 / 0 字节，上限 5 GB）——
  //   和下面 `/api/works` 默认空列表是同一个口径：绝大多数用例从零开始。
  meUsage = { count: 0, bytes: 0, limit: 5 * 1024 ** 3 }
  meCalls = 0
  meUsageGate = null
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me') {
      // `meGate` 演"跟随请求还在半路"：挂住不回，等测试放行
      if (meGate) await meGate.promise
      // `meFails` 演的是"登录/注册成功之后那一次问不出来"（服务器重启、网络瞬断）
      if (meFails) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
      if (!meUser) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
      meCalls++
      // 用户管理页挂载时会**再问一次**（要 usage）—— `meUsageGate` 只挂那一次，
      // 开机那一次（第 1 次）照常放行，不然连登录都进不去。
      if (meUsageGate && meCalls > 1) await meUsageGate.promise
      return jsonResponse(meUsage ? { user: meUser, usage: meUsage } : { user: meUser })
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
    // 恢复（Task 5）：打开 App 就会问一次"上次那条"。**默认一条都没有** ——
    // 这个文件里绝大多数用例的前提都是"从零开始"，不该被一条凭空冒出来的会话
    // 影响（恢复会把照片、对话、参数一起装回来）。要测恢复的那几条自己用
    // `withSessions` 盖上一条真的。
    // ⚠️ 这一条**必须接住**（不能让它掉进下面那个兜底的 blob 形状）：那样
    // `listSessions()` 会抛成"连不上服务器"，每条用例的控制台上都会多一行
    // 「上次那条没接回来」—— 噪声会盖住真话。
    if (url === '/api/sessions' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ sessions: [] })
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
    // 注销（2026-10-04）：和退出登录同一个形状 —— 后端那边这个人**整个没了**。
    // **必须真的接住这一条**：掉进下面那个兜底的 blob 形状的话，`del()` 会炸成
    // ApiError，而注销那条路上的 `.then(onSignedOut)` 永远不会执行。
    if (url === '/api/account' && (init?.method ?? 'GET') === 'DELETE') {
      meUser = null
      return jsonResponse({ ok: true })
    }
    // 改密码（2026-10-04）：成功就回 ok（真服务端会顺带发一张新票，jsdom 这里省掉）。
    // **必须真的接住这一条**：掉进下面那个兜底的 blob 形状的话 `post()` 会炸成
    // ApiError，界面显示的就是"没改成"那句 —— 测试绿在一个错误路径上。
    if (url === '/api/password' && (init?.method ?? 'GET') === 'POST') {
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

  // ★ 2026-10-03：`matchMedia` 也是 jsdom 没有的一个浏览器能力。
  //   **上面那个假的 IntersectionObserver 把它勾出来了**：落地页的 `Reveal`
  //   只有在"没有 IntersectionObserver"时才短路返回，现在有了假的，它就会往下走
  //   到 `matchMedia('(prefers-reduced-motion: reduce)')` —— 不铺这一行，
  //   「回门面」那几条一渲染落地页就抛 `matchMedia is not a function`。
  //   （`LandingPage.test.tsx` 里没铺，是因为那边**没有**假的 IntersectionObserver，
  //    于是它走的是短路那一支 —— 两边的差别在这儿，不是在组件的行为上。）
  //   一律回 `matches: false` = "用户没关动效"，也就是最普通的那个浏览器。
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))

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

/** 生成回来的图（`postEdit` 的应答）。三处用例共用一份。 */
const OK = { imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800 }

/** 按文字点一颗按钮（确认条那两颗走它 —— 不按位置找）。 */
async function clickByText(text: string) {
  const btn = [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement
  expect(btn, `屏幕上没有「${text}」这颗按钮`).toBeTruthy()
  await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 0)) })
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

/**
 * ★ 2026-10-05：打开对话栏里**加号**底下的一个工具（目前只有「滤镜」）。
 *
 * 它现在住在两层后面：输入框那颗 `＋` → 工具行 → 那一项。按**名字**找那一项
 * （以后加了新工具，这条辅助照样能用）。
 */
async function openChatTool(name: string): Promise<HTMLElement> {
  const plus = container.querySelector('.chat-plus') as HTMLButtonElement
  expect(plus).toBeTruthy()
  await act(async () => { plus.click(); await new Promise(r => setTimeout(r, 0)) })
  const tool = [...container.querySelectorAll('.chat-tool')]
    .find(b => (b.textContent ?? '').trim() === name) as HTMLButtonElement
  expect(tool, `加号里没有「${name}」这一项`).toBeTruthy()
  await act(async () => { tool.click(); await new Promise(r => setTimeout(r, 0)) })
  return tool
}

/** 等过落盘那一层防抖（800ms）。Task 4 和 Task 5 两节都用它。
 *
 *  ★ **真的等**（真定时器），不用假定时器：这个文件从头到尾都用真定时器，
 *  而 `vi.useFakeTimers()` 会把三条路一起冻上（`act` 里的微任务、
 *  那些"挂住不回"的 gate、以及 React 自己的调度）。900 只是留个余量 ——
 *  `setTimeout` 保证的是"至少"这么久，慢机器上照样成立。 */
async function waitPersist() {
  await act(async () => { await new Promise(r => setTimeout(r, 900)) })
}

/** 某一笔请求的请求体（已经 JSON.parse 过）。 */
function bodyOf(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body))
}

// ── 滤镜（★ 2026-10-05 T8 建，T9 / T11 / T12 共用）────────────────────
// 四个都按**文字**或**类名**找，不按位置 —— 位置是排版的事，文字才是用户的认知。

/** 微调区那一栏（`App.tsx` 里 `view.kind === 'adjust'` 才挂）。 */
const adjustPanel = () => container.querySelector('.panel') as HTMLElement
/** 打开微调区那一栏「滤镜」。**它默认是收着的**（spec §8.3），所以每一条都要先点一下。 */
async function openLutPanel() {
  const head = [...adjustPanel().querySelectorAll('.panel-group-head')]
    .find(b => (b.textContent ?? '').includes('Lut')) as HTMLButtonElement
  await act(async () => { head.click(); await new Promise(r => setTimeout(r, 0)) })
}
const lutTiles = () => [...adjustPanel().querySelectorAll('.lut-tile')] as HTMLButtonElement[]
const tileNamed = (name: string) => lutTiles().find(t => (t.textContent ?? '').includes(name))!
/** 面板里「滤镜」那一组（`section`）—— 强度滑块要**在这一组里面**找，别数全屏的滑块。 */
const lutSection = () => [...adjustPanel().querySelectorAll('.panel-group')]
  .find(g => g.querySelector('.panel-group-title')?.textContent === 'Lut') as HTMLElement

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

    // 三步 → 转盘上三格。★ 2026-10-06（晚）：对话里那两颗文字提示
    // （「回到这一步」/「你在这里」）退役了，跳步一律点转盘上的格子。
    const nodes = container.querySelectorAll<HTMLElement>('.strip-node')
    expect(nodes.length).toBe(3)

    // 退回最开始那一步（原图）
    await act(async () => { nodes[0]!.click() })

    await say('再来一次')
    // ★ 2026-10-05（Task 4）：站在旧步骤上生成，先过一下确认条（设计 §4.5）。
    await clickByText('继续改')

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

  /**
   * ★ 2026-10-06（用户原话：「对话区 AI 回复的太快，我认为它跟图片应该是同时出的」）。
   *
   * 钉的是**时刻**：助手那句应答（"好，这就去改。"）和图片**同一个批次**落下来。
   * 原来 `applyDecision` 在决策一出来就先 `say` 一句，用户先看到应答、再干等
   * 十来秒（一次生成 4~8.5 秒起）才有图 —— 两半看起来像两条不相干的回复。
   *
   * 红的样子（改动前）：生成还挂着的那一段里，那句 reply 已经躺在 `.bubble-text`
   * 里了（断言 ① 当场红）；改完是"放行生成 = 话和图一起到位"（断言 ②）。
   */
  it('★ 助手那句话跟着图一起出 —— 生成中不许先冒那句 reply，放行后话和图同时到', async () => {
    // 把这一次生成**挂住不回**（"正在改…大约 10 秒"那十几秒的真形状），等用例放行。
    const gate = makeGate<{ imageDataUrl: string; width: number; height: number }>()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockReturnValueOnce(gate.promise)

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const texts = () => [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')

    // ① 生成还在半路：屏上只有"正在改…"，那句 reply **一个字都还没出**。
    expect(container.textContent).toContain('正在改')
    expect(texts()).not.toContain('好，这就去改。')

    // ② 放行：那句话和图片（这一步的缩略图）**同一时刻**到位 ——
    //    同一个 act 之后一次断言：少了任何一半，"同时出"就不成立。
    await act(async () => {
      gate.open(OK)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(texts()).toContain('好，这就去改。')
    // ★ 而且**只说一遍**：这句应答今天是"只在成功那一刻说"（上一条用例钉的），
    //   将来谁要是半回退（决策出一遍、成功又补一遍），这里当场红。
    expect(texts().filter(t => t === '好，这就去改。')).toHaveLength(1)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)  // 原图那格 + 新这一步的
  })

  /**
   * ★ 2026-10-06（用户原话：「而且中途思考要有一些加载动作比如正在思考，要让用户
   * 知道你在干嘛」）。这条钉生成中那十几秒里的三样"看得见"：
   *   ① 那条「正在…」气泡，文字后面是**三颗跳动的点**（替掉了原来 12px 的小转圈）；
   *   ② 图要出现的地方先摆一颗**占位块**（图到了原地换掉）；
   *   ③ 画布拿到 `busy: true`（真的 Canvas 按它盖那层暗罩 —— 画布在 App 测试里
   *      是假掉的，所以看到的是它收到的那一帧 prop）。
   * ★ 2026-10-06（晚）：②那块占位从**对话里**搬到了**照片区上方那圈转盘上**
   *   （用户：「对话区不留下照片了」）—— 判据跟着改成 `.strip-pending`，
   *   位置也一起钉：它摆在**队尾的后一格**（新的一版会落在那儿）。
   * 放行之后三样都要收工：占位块消失、真图换上、画布不再忙。
   */
  it('★ 生成中「等待看得见」—— 跳动的点 + 时间轴上的占位块 + 画布暗罩，放行后收工', async () => {
    const gate = makeGate<{ imageDataUrl: string; width: number; height: number }>()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockReturnValueOnce(gate.promise)

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    // ① 三颗点：在那条「正在…」气泡里
    const dots = container.querySelector('.bubble.pending .pending-dots')
    expect(dots, '那条「正在…」气泡上没有跳动的点').toBeTruthy()
    expect(dots!.querySelectorAll('i')).toHaveLength(3)
    // ② 占位格子（等十几秒的那一块）—— 摆在转盘上、**队尾的后一格**
    //    （这条会话只有原图一格 → 落在 1 号位 = rotateY(60deg)）
    const pending = container.querySelector('.strip-pending') as HTMLElement
    expect(pending, '生成中转盘上没有占位格子').toBeTruthy()
    expect(pending.style.transform).toContain('rotateY(60deg)')
    // ③ 照片那边的暗罩（判据是这一帧 prop，不是字符串）
    expect(canvasProps.props.at(-1)?.busy).toBe(true)

    await act(async () => {
      gate.open(OK)
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.strip-pending')).toBeNull()   // 占位让位给真图
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(canvasProps.props.at(-1)?.busy).toBe(false)
  })

  /**
   * ★ 2026-10-06：决策那 1.3~1.6 秒写的是「正在思考…」——
   * 原来写「正在看照片…」：那半句说的是**我们的动作**，而用户要的是
   * "知道你在干嘛"，"在想"才是这一刻这件事。
   * ⚠️ 这一段**不盖暗罩**（照片那边只在**生成**时盖）：一个 1.5 秒的闪暗、
   * 紧接着再暗十来秒，读起来是界面在抽。
   */
  it('★ 决策那一段：「正在思考…」（不再写"正在看照片"），而且照片上不盖暗罩', async () => {
    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)

    await renderApp()
    await uploadPhoto()
    await say('亮一点')

    expect(container.textContent).toContain('正在思考…')
    expect(container.textContent).not.toContain('正在看照片')   // 旧文案全站下线
    expect(container.querySelector('.bubble.pending .pending-dots')).toBeTruthy()
    // 「正在思考」不是"生成中"：占位块和暗罩都不许亮（占位块在时间轴上，
    // 见上面那条「等待看得见」）
    expect(container.querySelector('.strip-pending')).toBeNull()
    expect(canvasProps.props.at(-1)?.busy).toBe(false)

    await act(async () => {
      gate.open(decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.textContent).not.toContain('正在思考')
  })

  /**
   * ★ 2026-10-06（评审 Minor）：模型声明 `route: 'generate'` 却给了**空
   * `editPrompt`** 的退化决策 —— 落回"立刻说一句"，**不许静默**。
   * 红的样子（改动前）：这一版会进 `runGenerate`、撞上它开头的
   * `if (!editPrompt) return` —— 钱不花、图不画，但**一个字都不说**
   * （用户说了一句话，屏幕上没有任何反馈 —— 静默失败）。
   * ⚠️ 判据是 `lastReply()` 那条：只断"没花钱"的话，退化路悄悄吞掉半句
   *    照样绿。
   */
  it('★ 声明 generate 却给了空 editPrompt 的退化决策：不生成，但必须回一句话', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '', reply: '这句不改，先这么看。' }))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(api.postEdit).not.toHaveBeenCalled()        // 没有 editPrompt 就一个钱都不花
    expect(lastReply()).toBe('这句不改，先这么看。')     // 但话必须说 —— 静默才是红线
  })

  /**
   * ★ 2026-10-06（评审必修）：确认条那支和上面那条**要对称** —— 模型声明
   * `route: 'generate'` 却给了空 `editPrompt`、而光标停在**旧步骤**上时，
   * 条子同样不许挂。
   * 红的样子（改动前）：条子照挂（"后面还有 N 步…"）→ 点「继续改」→
   * `runGenerate('')` 撞上它开头的 `if (!editPrompt) return` —— **一行反馈都
   * 没有**，还白烧一个消息号。判据两条缺一不可：①条子不许出现 ②必须有一句
   * reply 收场（只断"没花钱"的话，静默那条路照样绿）。
   */
  it('★（评审必修）空 editPrompt + 站在旧步骤上：不弹确认条，也不许一声不吭', async () => {
    // 先造两版（光标落在最新一步），再跳回第一步 —— 出发点是**旧步骤**
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好，这就去掉。' }))
    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '换成黄昏', reply: '好，换成黄昏。' }))
    await say('天空换成黄昏')
    await act(async () => {
      ;(container.querySelector('.strip-node') as HTMLButtonElement).click()   // 转盘第一格 = 原图
      await new Promise(r => setTimeout(r, 0))
    })

    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '', reply: '这句不改，先这么看。' }))
    await say('把后面那个人去掉')

    expect(container.textContent).not.toContain('后面还有')   // ① 条子不许挂
    expect(api.postEdit).toHaveBeenCalledTimes(2)            // 钱一分没花（仍只前两次）
    expect(lastReply()).toBe('这句不改，先这么看。')           // ② 必须有一句收场
  })

  /**
   * ★ 2026-10-06：上面那条改动的**白捡好处** —— 生成失败时那句"好，这就去改。"
   * 不再先冒出来（原来 `say` 抢在 `postEdit` 之前说，紧接着再补一句"没改成功"，
   * 读起来像"先答应、后没做成"）。
   * 失败路只说自己的话：这里钉住"那句 reply 一个字都不说、但失败的话必须在"。
   */
  it('★ 生成失败：那句 reply 不说 —— 只说「再试一次」', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockRejectedValue(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const texts = [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')
    expect(texts.some(t => t.includes('再试一次'))).toBe(true)   // 失败要说话，不能闷着
    expect(texts).not.toContain('好，这就去改。')                 // 但没说成的事，不先答应
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

    // ⚠️ 选的是"这一行里**不是加号**的那颗"（★ 2026-10-05）：输入框那行左边多了
    //    那颗加号（打开工具行），裸的 `.chat-input button` 会先挑中它。
    //    也**不能**写死 `[type="submit"]`：生成中那颗是「停止」（`type="button"`），
    //    写死了这一条就永远挑不到东西。
    const before = container.querySelector('.chat-input button:not(.chat-plus)') as HTMLButtonElement
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
    const after = container.querySelector('.chat-input button:not(.chat-plus)') as HTMLButtonElement
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
      (container.querySelector('.chat-input button:not(.chat-plus)') as HTMLButtonElement).click()
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
    // ★ 2026-10-05（Task 4）：第 0 颗在**旧步骤**上 —— 先问一句（设计 §4.5）。
    await clickByText('继续改')

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

    // 还没改过：历史里只有原图那一步 —— 转盘上就一格（对号入座那格是
    // "你在这里"的位置，它是 `<span>`，不是按钮）。
    // ★ 2026-10-06（晚）：对话里那两颗文字提示退役之后，这里数的是转盘。
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
    expect(container.querySelector('.strip-node.current')?.tagName).toBe('SPAN')
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
    // ⚠️ 2026-10-01（Task 6）末尾多了一颗「新的一张」（§6.4）—— 两条清单都跟着加，
    //    它们钉的是"那一格的两种长相"和"有没有混进别的东西"，不是"永远只有三颗"。
    //    （2026-10-03 起 `.actions` 里真的只剩这四颗了：品牌名和那颗 👤 撤出顶栏
    //    之后，这里不用再解释"谁是谁的兄弟"。）
    //    ★ 2026-10-04：**最左边那颗「调色」搬去了左栏**（用户：「那个微调照片的
    //    放在导航栏单列出来」）—— 这条清单跟着少一颗，现在只剩**"把图拿走"**
    //    那三颗。谁要是往这儿再加一颗改图的按钮，这条断言会红。
    expect(topbarButtons()).toEqual(['分享', '存进作品', '新的一张'])
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
    //    （2026-10-01 Task 6：末尾又多了一颗「新的一张」，清单跟着加。）
    //    （★ 2026-10-04：「调色」搬去左栏，清单从头上去掉一颗 —— 见上一条。）
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    expect(topbarButtons()).toEqual(['下载', '存进作品', '新的一张'])
  })

  it('点「下载」→ 真的下载一份，文件名和分享那条一样', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    await click('下载')

    expect(saveMod.downloadImage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveMod.downloadImage).mock.calls[0][1]).toBe('p_pinkrose.jpg')
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
    expect(vi.mocked(saveMod.shareImage).mock.calls[0][1]).toBe('p_pinkrose.jpg')
  })

  it('⚠️ 点「存进作品」→ 不偷偷下载，也不偷偷变成分享（§3.4）', async () => {
    // ⚠️ **这条 2026-09-25（Task 13）改过一半。** 原文是「老老实实下载，
    //   不许偷偷改成分享」—— §3.4 把前半句改了：这颗按钮现在只做"存进作品"
    //   这一件事，下载挪到作品集里、由用户自己决定要哪张。
    //   后半句照旧守着 —— 用户原话：「那有时候不想立即分享也得分享喽」。
    //   一条"能分享就一律分享"的实现会让它红，而那正是他不要的。
    //   ★ 2026-10-06：按钮的字从「保存」改成「存进作品」（用户提的"不能模棱两可"
    //     —— 它和左边那颗下载都是"把图留下"，「保存」没说存到哪儿去）。
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    await renderApp()
    await uploadPhoto()
    await click('存进作品')

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
 * 挤没了（见验收记录 §15），修好之后仍然值得把每一步的画面挂出来：
 * 它是「撤销」的入口（spec §2.4：不设撤销按钮，翻历史就是撤销）。
 *
 * ★ 2026-10-06（晚）**换了个家**：用户说「对话区不留下照片了，改成像我这样的…
 * 上方是可左右滚动的历史记录照片类似于 git 吧也就是回到那一步，下方对应记录的
 * 图片」—— 每一步的小图从**对话气泡下面**整条搬到**照片区上方那条时间轴**上
 * （`ui/StepStrip`；它的长相和交互在 `StepStrip.test.tsx` 里钉着）。
 * 这一组守的是**搬家路上丢没丢东西**：小图对不对得上那一步、画的是不是那一步的
 * 颜色、以及"对话区里确实没有照片了"。
 */
describe('历史小图：每一步都看得见（照片上方那条时间轴上）', () => {
  /** 时间轴上第 index 格的小图。 */
  function thumbOf(index: number): string | null {
    const imgs = container.querySelectorAll<HTMLImageElement>('.strip-thumb')
    return imgs[index]?.getAttribute('src') ?? null
  }

  it('传完照片，时间轴上就有一格（原图那张）', async () => {
    await renderApp()
    await uploadPhoto()
    expect(thumbOf(0)).toBe('thumb:' + JSON.stringify(ZERO))
  })

  it('★ 点某一格 = 回到那一步：下面的大图跟着换', async () => {
    // 这条是整件事的**产品定义**（用户画的草图）：格子不是装饰，是"回到那一步"
    // 的第二条路 —— 和对话里那颗按钮走的是同一个 `onJump`。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '提亮一点', reply: '提亮了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('亮一点')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)

    // 点回「原图」那一格：画面换成上传的那张（`__tag: 'upload'` —— 生成回来的
    // 是 `decoded-N`，一看就分得开）
    await act(async () => {
      container.querySelectorAll<HTMLElement>('.strip-node')[0]!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    // 站的位置也跟着挪：「你在这里」落在原图那一格上（它是 span，不是按钮）
    expect(container.querySelector('.strip-node.current')?.tagName).toBe('SPAN')
    expect(container.querySelectorAll('.strip-node')[0]!.className).toContain('current')

    // 再点回新那一步：画面又换成生成回来的那张（跳转**不删**任何一步）
    // ⚠️ 必须**重新查一遍**：上一步把那一格从 span 换成了 button，
    //   React 换元素类型时是整只换掉的 —— 揣着旧的引用点它等于点了空气。
    await act(async () => {
      container.querySelectorAll<HTMLElement>('.strip-node')[1]!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'decoded-1' } })
  })

  it('★ 调色那一屏没有时间轴（和对话栏同一条规矩）—— 回「修图」它又在', async () => {
    // 用户 2026-10-04 把这一屏定义成"拖滑块改"的界面区（「调色就是对图片微调
    // 的界面区不是对话区」）—— 时间轴是"说话改"那条路上的东西，不跟过去。
    await renderApp()
    await uploadPhoto()
    expect(container.querySelector('.stage .strip')).toBeTruthy()

    await goNav('调色')
    expect(container.querySelector('.strip')).toBeNull()

    await goNav('修图')
    expect(container.querySelector('.stage .strip')).toBeTruthy()
  })

  it('★ 工具行只在调色屏；修图屏那条带子还是历史转盘', async () => {
    // 写法照上一条（挂起 App → 上传一张照片 → 用左栏切屏）。
    await renderApp()
    await uploadPhoto()

    // 修图屏：没有工具行 —— 这一屏照片上方那条带子是历史转盘（上一条钉的）。
    expect(container.querySelector('.tool-row')).toBeNull()
    expect(container.querySelector('.stage .strip')).toBeTruthy()

    // 进调色屏：工具行来了（裁剪 / 对比两颗），转盘换下去了。
    await goNav('调色')
    expect(container.querySelector('.tool-row')).toBeTruthy()
    expect(container.querySelector('.strip')).toBeNull()

    // ★ 开着工具 = 手势停用：App 把 `viewLocked` 交给 Canvas。真画布按它停掉
    //   滚轮 / 拖动 / 双击、并且不画那排缩放按钮 —— 那几条（含 `.zoom-bar`
    //   不在）量在 `Canvas.zoom.test.tsx` 里，这儿的画布是假的、量不到那些 DOM，
    //   所以这一层只钉"App 有没有把它送出去"。
    const cropCell = () => container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => { cropCell().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(cropCell().className).toContain('on')                 // 亮着了
    expect(canvasProps.props.at(-1)?.viewLocked).toBe(true)      // 手势已停用

    // 切回修图屏：工具行跟着没了（它只在调色那一屏）。
    await goNav('修图')
    expect(container.querySelector('.tool-row')).toBeNull()
    expect(container.querySelector('.stage .strip')).toBeTruthy()

    // ★ 切屏要把工具**收掉**（App 里那条 `[view.kind]` 的 effect —— 不收的话
    //   回到调色屏时它还开着，而那时候照片可能已经换了，裁剪框会落在新照片上）。
    //   判据：刚才开着的那颗不再亮、第二行不在、手势也放开了。
    await goNav('调色')
    expect(container.querySelector('.tool-row')).toBeTruthy()
    expect(cropCell().className).not.toContain('on')
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.viewLocked).toBe(false)
  })

  /**
   * ★ 2026-10-06（晚）：**对话区里不再有照片**（用户原话：「对话区不留下照片了」）。
   * 这条原来钉的是相反的一面 —— 2026-10-05 用户点名要"文字一块、图一块"；
   * 今天第二块整条搬走（`StepStrip`），所以要钉的换成了"消息里一张图都不许有"。
   * ⚠️ 判据按**结构**钉（`.chat img` 一个都不许有），不按"某个角落"那种松判据
   * —— 图哪天从别的路溜回对话区，这一条当场红。
   */
  it('★ 对话区里不再有照片 —— 小图只在转盘上', async () => {
    await renderApp()
    await uploadPhoto()
    const msg = container.querySelector('.msg.assistant')
    expect(msg).toBeTruthy()
    // 那条消息里：只有话。★ 2026-10-06（晚）：它连操作行都没有了 ——
    // 「你在这里」那颗位置标记退役之后，原图那条一颗按钮都不剩。
    expect(msg!.querySelector('img')).toBeNull()
    expect(msg!.querySelector('.bubble-text')?.textContent).toBe('准备好啦，说说想怎么改？')
    expect(msg!.querySelector(':scope > .bubble-actions')).toBeNull()
    // 整个对话栏里一张图都没有；小图在舞台上那圈转盘里
    expect(container.querySelector('.chat img')).toBeNull()
    expect(container.querySelector('.stage .strip')).toBeTruthy()
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

  it('没改图的那一趟不占格（时间轴上还是只有原图）', async () => {
    // 「我不太确定你指的是哪个」这种消息后面没有新的一步 —— 时间轴上当然也
    // 不该冒出一格（冒出来会让用户以为那一步真的改了什么）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把那个去掉')

    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)  // 只有原图那格
  })
})

/**
 * ★ 2026-10-06（裁剪）：工具行第一颗 —— 框 + 第二行 + **完成 = 本地生成新的一步**。
 *
 * 这一层只验**接线**（送的是当前底图、推了步、参数没被重置、能回到上一步）。
 * 像素对不对是 Task 6 真机的事：jsdom 里连 `createImageBitmap` 都没有，
 * 所以 `src/image/crop` 整个假掉（见文件顶上的 `vi.mock`），
 * 真画布那半（转多少度、缩多少倍、框画在哪）量在 `Canvas.zoom.test.tsx`。
 */
describe('★ 裁剪：框 + 第二行 + 完成 = 本地生成新的一步', () => {
  /** 打到某条会话上的更新请求（`steps` 是唯一看得见历史的地方）。 */
  const putCalls = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === 'PUT')
  /** 交给画布的裁剪现场（App 算好那一整块）。 */
  const sceneOf = () => canvasProps.props.at(-1)?.crop as {
    rect: { x: number; y: number; w: number; h: number }
    aspect: number | null
    angle: number
    inner: { x: number; y: number; w: number; h: number }
  } | null

  /** 进裁剪：先去调色屏，再点工具行那颗「裁剪」。 */
  async function openCrop() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.tool-row-second'), '开着裁剪时第二行该在').toBeTruthy()
  }

  /** 拨「水平矫正」（走调色面板同一个滑块零件：点数字 → 输入 → 回车）。 */
  async function setStraighten(v: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '水平矫正')!
    expect(row, '第二行该有一条「水平矫正」').toBeTruthy()
    await act(async () => {
      (row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const box = row.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(box, String(v))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 裁完之后：是新的一步、参数没被重置、还能回到上一步', async () => {
    await renderApp()
    await uploadPhoto()
    // ① 先把亮度改到 30（本文件里"改参数"的标准写法：说一句话 → 路由给增量）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30 }, reply: '亮了一点。' }))
    await say('亮一点')
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(30)

    // ② 进裁剪 → 完成
    await openCrop()
    expect(sceneOf(), '开着裁剪时现场该交给画布').toBeTruthy()
    await clickByText('完成')

    // ③ 裁的是**底图**（送进去的是当前这张），回来的那张成了新底图
    expect(vi.mocked(cropMod.cropToBitmap)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(cropMod.cropToBitmap).mock.calls[0]![0]).toMatchObject({ __tag: 'upload' })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'cropped' } })

    // ④ 参数一个都没丢（铁律：裁剪只改几何）
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(30)
    // ⑤ 已经不在裁了（现场和工具一起收掉）
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()

    // ⑥ 历史真的多了一步（落盘那趟是唯一看得见 steps 的地方）
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图', '裁剪'])

    // ⑦ 回修图屏：助手说了一句「裁好了。」；转盘上两格，点回原图那格能回去
    //   （调色那一屏**没有对话栏**，所以那句回话得到这一屏才看得见）
    await goNav('修图')
    expect(lastReply()).toBe('裁好了。')
    const nodes = () => [...container.querySelectorAll('.strip-node')] as HTMLElement[]
    expect(nodes()).toHaveLength(2)
    await act(async () => { nodes()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })

  it('★ 第二行：比例 / 左右转 / 水平矫正 —— 角度一变，框重置成居中的最大内接矩形', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()

    // 开着的这一刻：角度 0、自由档 → 框就是整张照片（外框 = 照片本身）
    expect(sceneOf()!.angle).toBe(0)
    expect(sceneOf()!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(sceneOf()!.aspect).toBeNull()

    // ① 挑 1:1：框按比例收成居中的正方形（1200×800 的照片 → 宽 800/1200）
    await clickByText('1:1')
    const sq = sceneOf()!
    expect(sq.rect.w).toBeCloseTo(800 / 1200, 6)
    expect(sq.rect.h).toBeCloseTo(1, 6)
    expect(sq.rect.x).toBeCloseTo((1 - 800 / 1200) / 2, 6)
    // ⚠️ 交给框的比例是**归一化**的：像素比 1 × 外框高 / 外框宽（800/1200）
    expect(sq.aspect).toBeCloseTo(800 / 1200, 6)

    // ② 左转：角度 +90（正角度 = 照片逆时针转），框跟着重置
    await clickByText('左转')
    expect(sceneOf()!.angle).toBe(90)
    expect(sceneOf()!.rect.w).toBeCloseTo(1, 6)          // 转直角 → 外框就是那张竖过来的照片
    expect(sceneOf()!.rect.h).toBeCloseTo(2 / 3, 6)      // 锁着 1:1 → 高按比例收
    expect(sceneOf()!.rect.y).toBeCloseTo(1 / 6, 6)      // 居中

    // ③ 右转两下：回到 -90°（再来一遍，方向要能反着走）
    await clickByText('右转')
    await clickByText('右转')
    expect(sceneOf()!.angle).toBe(-90)

    // ④ 拖水平矫正到 7°：角度实时进预览，框**重置**成"居中的最大内接矩形"
    //    （转过就有空角，框必须缩回来 —— 按 1:1 收过之后是个居中的正方形）
    //    ⚠️ 报出来的是**合角**（`effectiveAngle` = 整转 × 90 + 矫正角）：
    //    上面右转两下把 turns 走到 -1，所以是 -90 + 7。
    await setStraighten(7)
    const tilt = sceneOf()!
    expect(tilt.angle).toBe(-90 + 7)
    expect(tilt.rect.w).toBeLessThan(1)
    // 框守住了比例档：**归一化**的宽高比 == 交给框的那个数。
    // ⚠️ 拿 `rect.w ≈ rect.h` 当"这是正方形"是错的 —— 像素 1:1 在斜过来的
    //    外框里**不是**归一化 1:1（外框宽高不等），两者之差正是 `aspect` 那一次换算。
    expect(tilt.rect.w / tilt.rect.h).toBeCloseTo(tilt.aspect!, 6)
    expect(tilt.rect.x).toBeCloseTo((1 - tilt.rect.w) / 2, 6)         // 居中
    expect(tilt.rect.y).toBeCloseTo((1 - tilt.rect.h) / 2, 6)
  })

  it('★「取消」= 什么都没发生：不推步、不换底图、工具收掉', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('取消')

    expect(vi.mocked(cropMod.cropToBitmap)).not.toHaveBeenCalled()
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()
    // 历史上还是只有原图那一步（落盘那趟也不该多送什么）
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })

  it('★ 站在中间那一步裁：被切掉的步骤，它们的位图要还回去（不关就是漏 GPU 内存）', async () => {    await renderApp()
    await uploadPhoto()
    // 先生成一版（生成回来的那张位图由 `decodedBitmaps` 记着）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    await say('去掉路人')
    const generated = decodedBitmaps.at(-1)!
    expect(generated.close).not.toHaveBeenCalled()

    // 回到**原图**那一步（转盘第一格），在那儿裁 —— 那一步之后的会被切掉，
    // 它的位图从这一刻起没人用了（`localStep` 里那条 `cutAfter`）。
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await openCrop()
    await clickByText('完成')

    expect(generated.close, '被切掉那一步的位图必须关掉').toHaveBeenCalled()
  })

  it('★（评审 Critical）裁完之后那一趟落盘必须**重新带底图** —— 不带就等于没裁', async () => {
    // 根因：`commitCrop` 只推了 history，没推 `baseSeqRef` —— 而落盘那趟判
    // "底图换过没有"（`changed`）用的就是它，`patch.base` / `patch.thumb` 全在
    // 那个 `if (changed)` 里。不推的后果**一句错都不报**：
    //   服务端手里还是没裁过的那张，第 2 步被记成 `reusesPrev`，
    //   刷新之后画面是原图（宽高比 1.5），转盘上却还留着一个叫「裁剪」的格子。
    // 同一条规矩在"删掉最新一步"那边也有（那条用例钉的是封面）—— 换了底图就要重传。
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('完成')
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect(body.base, '裁剪之后那一趟必须重新带上底图').toBeTruthy()
    expect(body.thumb, '封面也要跟着换（左栏列表上显示的是"最后那张"）').toBeTruthy()
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图', '裁剪'])
  })

  it('★（评审 Important ②）同一批次里还有别的 setState 时，站中间裁照样把未来那几步切掉', async () => {
    // 根因：`commitCrop` 在 `setHistory` 的 **updater 里面**读 `cursorIdRef.current`，
    // 而同一批次末尾的 `moveCursor(id)` 会把同一个 ref 改成**新步骤自己的 id**。
    // React 的"eager 路径"只在"这个 fiber 没有挂起的更新"时才当场跑 updater ——
    // 一旦同一批里还有别的 setState，updater 就落到**渲染时**才跑，读到的已经是新值：
    // `cutAfter(prev, id)` 找不到那个 id → 未来那几步**不会被切**（顺序也跟着错）。
    // ⚠️ 所以这条用例必须**制造那个"别的 setState"**：平时（只有它一个）走 eager 路径，
    //    测试全绿 —— 那正是这个 Bug 一直没被测出来的原因。
    //    做法：把建议卡片那趟挂住，在裁剪那句 await 回来之前放行它
    //    （`suggesting` 由真变假 = 一个真实的 App state 更新，会占住 lane）。
    const cardsGate = makeGate<SuggestResponse>()
    vi.mocked(api.postSuggest).mockReturnValueOnce(cardsGate.promise)

    await renderApp()
    await uploadPhoto()
    // 先造出"未来那一步"：生成一版
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await say('去掉路人')
    // 回到原图那一步（转盘第一格）—— 在那儿裁 = **站中间裁**
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await openCrop()

    // 「完成」卡在 cropToBitmap 上：先放行卡片那趟（占住 lane），再放行裁剪
    const gate = makeGate<ImageBitmap>()
    vi.mocked(cropMod.cropToBitmap).mockReturnValueOnce(gate.promise)
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '完成') as HTMLButtonElement
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      cardsGate.open({ cards: [], degraded: false })
      await Promise.resolve()
      await Promise.resolve()
      gate.open(fakeBitmap('cropped'))
      await new Promise(r => setTimeout(r, 0))
    })

    // 未来那一步（生成的那一版）必须已经被切掉：转盘上只剩「原图 + 裁剪」两格
    await goNav('修图')
    expect(container.querySelectorAll('.strip-node'), '站中间裁必须切掉后面那几步').toHaveLength(2)
  })
})

/**
 * ★ 2026-10-06（对比）：**分屏 + 拖把手**（spec §3.3）—— 工具行那颗格子这一侧。
 *
 * 这一层只验**接线**：备的是哪一份原图、备得够不够懒、"对比不算工具开着"
 * （不锁手势、不归位）、两个入口一个状态。分屏那一层本身（剪裁 / 拖动 / 夹取）
 * 量在 `ui/CompareSplit.test.tsx`，交给真画布那几条量在 `Canvas.zoom.test.tsx`
 * —— 这一层挂的画布是假的，量不到那些 DOM。
 */
describe('★ 对比：备原图 + 一个开关', () => {
  const last = () => canvasProps.props.at(-1)!
  /** 工具行那颗「对比」格子（右下角那颗住在**真画布**里，这一层挂的是假画布）。 */
  const cell = () => container.querySelector('[aria-label="对比"]') as HTMLButtonElement
  const clickCell = () => act(async () => {
    cell().click(); await new Promise(r => setTimeout(r, 0))
  })

  it('★ 点「对比」才去备原图（懒做）；备的是**大图**，不是 480 的缩略图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    // 懒做：还没点它，一张位图都不该多解（每张照片白编一版 2048 是白花的）
    expect(decodedBitmaps, '还没点「对比」，原图一份都不该备').toHaveLength(0)

    await clickCell()
    // 前缀 `original:` = 走的是 `bitmapToDataUrl`（0.9、长边 ≤ 2048 那份）。
    // ⚠️ 拿 `originalPreview`（480 的缩略图，前缀 `thumb:`）顶上 → 这一句当场红。
    //    分屏是**并排比**：左边糊右边清楚，用户会以为是我们把照片弄糊了。
    expect(last().compareWith).toBe('original:decoded-1')
    // 备图那张位图**用完就关**：`ImageBitmap` 占的是 GPU 内存（这个项目的老账）
    expect(decodedBitmaps.at(-1)!.close).toHaveBeenCalled()
  })

  it('★「对比」不算"工具开着"：手势不停用、视图也不归位', async () => {
    // spec §3.3：用户多半正放大着才去按对比 —— 把他拽回「适应窗口」正好毁掉
    // 这个用法。所以 `viewLocked` / `resetKey` 这两样**只认裁剪**。
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const resetBefore = last().resetKey

    await clickCell()
    expect(last().comparing).toBe(true)
    expect(last().viewLocked, '对比态里缩放 / 平移照常能用').toBe(false)
    expect(last().resetKey, '进对比不该把视图拽回「适应窗口」').toBe(resetBefore)
    // ★ 开着对比**没有第二行**：它是开关、没有自己的控件，而空着的第二行会占掉
    //   照片 37px（开着对比时照片整张跳一下，正好打在"放大着比细节"这个用法上）。
    expect(container.querySelector('.tool-row-second'), '对比不该长出第二行').toBeNull()

    // 再点一下同一颗 = 退出（"对比是个开关，不是模式"，spec §3.0）
    await clickCell()
    expect(last().comparing).toBe(false)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })

  it('★ 右下角那颗和工具行那颗调的是**同一个**开关', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    // 右下角那颗住在真画布里；这一层拿到的是同一个开关（App 只做这一份）
    const onCompare = last().onCompare
    expect(onCompare, 'App 要把那颗按钮的回调交给画布').toBeTypeOf('function')
    await act(async () => { onCompare!(); await new Promise(r => setTimeout(r, 0)) })
    expect(last().comparing).toBe(true)
    expect(cell().className, '从右下角开，工具行那颗要跟着亮').toContain('on')

    await act(async () => { last().onCompare!(); await new Promise(r => setTimeout(r, 0)) })
    expect(last().comparing).toBe(false)
    expect(cell().className).not.toContain('on')
  })

  it('★ 恢复出来的会话照样能对比（原图从那一条路来）', async () => {
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    await renderApp()
    await goNav('调色')
    await clickCell()
    expect(last().compareWith).toMatch(/^original:/)
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
    // ★ 2026-10-06（晚）：那一步在**转盘**上（刚上传完站在原图那格）。
    expect(lastReply()).toContain('准备好啦')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
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

    // ★ 2026-10-05（Task 4 修正）：点选那条路**保留**那句 reply —— 它一直是两条
    //   气泡（"好。" + "我不太确定…"），先问再做那半句不能因为确认条那次重构丢掉。
    const texts = [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')
    expect(texts).toContain('好。')                      // 那句 reply 又回来了
    expect(texts.at(-1)).toContain('不太确定')            // 最后一条仍是那句问句
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

    // ★ 这一步还得挂在**一条真的消息**上。转盘上那一格和「再来一版」都是按
    //   消息 id 对号的 —— 用 `nextId()` 这种"没有消息的 id"会让它们**双双
    //   静默失效**：用户点完圈，转盘上什么都不多，也没法回到这一步。
    // ★ 2026-10-06（晚）：点完「就改这里」站的就是**新的那一步** ——
    //   转盘上它是正面那格（`<span>`，不是按钮）。
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(container.querySelectorAll('.strip-node')[1]!.className).toContain('current')
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
    const sendBtn = container.querySelector('.chat-input button:not(.chat-plus)') as HTMLButtonElement
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
    // 「回到这一步」和时间轴上的小图是**全仓唯二没有 busy 闸门**的控件，而点选期间
    // busy 恰好是空的（模型说完"拿不准"就收工了）—— 所以这条路径**一个竞态都
    // 不需要**就够得到，用户点两下就能走到：点选期间跳走 → 确认条还在 →
    // 点「就改这里」→ confirmMark 的四道守卫全过 → 把**旧标记**画在**换过的
    // 底图**上、配旧那句话，扣一次生成的钱（约 12,900 tokens）。
    // 跳走和下一条消息是一回事：上一条歧义翻篇。
    //
    // ★ 2026-10-06（晚）：照片撤出对话区之后，"点小图跳回去"这条路走的是
    //   **时间轴上那一格**（同一个 `onJump`）。⚠️ 这一条要的是一颗**点得动**的
    //   格子 —— 站着那格是"你在这里"标记（`<span>`），所以这里恢复一条**两步**
    //   的会话、站在最新的那步上，再点**原图**那一格。
    //   （上传一条新照片的路径在这里只有一步，"点得动"的格子一个都没有。）
    withSessions([makeSession(7, 2, '上次那句', 'S7')])
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))
    await renderApp()
    await say('把后面那个人去掉')
    await tapPhoto()
    expect(container.textContent).toContain('就改这里')

    const jump = container.querySelectorAll<HTMLElement>('.strip-node')[0]!
    expect(jump.tagName).toBe('BUTTON')
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

  it('★ 站在旧步骤上点选：确认条里带提醒，「就改这里」一次点到位（切 + 生成）', async () => {
    // 恢复一条 3 步的会话（站在最新）→ 跳回原图 → 模型说拿不准 →
    // 点一下 → 条子里该有"后面还有 2 步" → 「就改这里」= 直接切 + 生成。
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    const steps = [...container.querySelectorAll<HTMLElement>('.strip-node')]
    await act(async () => { steps[0]!.click(); await new Promise(r => setTimeout(r, 0)) })  // = 原图那步
    await say('把后面那个人去掉')
    await tapPhoto()

    expect(container.textContent).toContain('后面还有 2 步')     // 提醒并进来了
    expect(api.postEdit).not.toHaveBeenCalled()                  // 还没花钱

    await clickByText('就改这里')

    expect(api.postEdit).toHaveBeenCalledTimes(1)
    // 切了：转盘上只剩原图 + 新那一步
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
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
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await renderApp()
    expect(container.querySelector('.welcome')).toBeTruthy()
    expect(container.querySelector('.empty-state')).toBeNull()
    expect(格子()).toContain('调色')      // 而那一格**还在**
  })
})

/**
 * ★ 2026-10-04（「专业面板」终审 I1）：**「照着这张调」的合流语义**。
 *
 * 拟合（`core/colorMatch.ts`）从 `ZERO` 起跑，产出的是**六个参数的绝对值** ——
 * 它的世界里，这一批新加的七条参数全是 0。可用户完全可能先拖过色彩平衡、
 * 分离色调强度，再点「照着这张调」：合流点要是不把那五条**参与颜色的**新参数
 * 归零，屏幕上那套颜色就**不是**拟合算过的那套（结果里混进拟合没看过的色偏，
 * 而且不报错）。清晰度 / 暗角相反 —— 它们是构图与局部细节，照旧保留。
 *
 * 这一条走的是**真链路**：文件选择器 → `decodeImageFile`（假）→ `samplePixels`
 * （假：jsdom 没有 2D 画布）→ `matchToReference`（**真**）→ `setParams`。
 * 拟合本身一个字节没假 —— 假掉它，这条测的就只剩"我把自己的假设测了一遍"。
 */
describe('★ 「照着这张调」：拟合的世界 = 看到的世界（2026-10-04）', () => {
  /** 源图（上传的那张）与参考图的采样点。几个点就够 —— 拟合看的是色彩分布。 */
  const SRC: Rgb[] = [[96, 92, 88], [128, 120, 112], [160, 150, 140], [80, 84, 90]]
  const REF: Rgb[] = [[168, 158, 140], [196, 184, 164], [150, 152, 140], [140, 142, 150]]

  it('★ 套用参考图：六条换拟合值、五条参与颜色的归零；清晰度/暗角原样留着', async () => {
    await renderApp()
    await uploadPhoto()

    // ① 先制造"用户已经拖过新参数"的现场（走模型那条路 —— 和改参数同一个入口）。
    //    顺带带上清晰度 / 暗角：它们待会儿是**要被留住**的那两条。
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({
      route: 'params',
      paramDeltas: {
        vibrance: 30, cbYellowBlue: 60, splitAmount: 40, splitHiHue: 200,
        clarity: 20, vignette: -30,
      },
      reply: '调好了。',
    }))
    await say('调个色')
    expect(canvasProps.props.at(-1)?.params).toMatchObject({
      vibrance: 30, cbYellowBlue: 60, splitAmount: 40, clarity: 20, vignette: -30,
    })

    // ② 「照着这张调」那颗按钮住在调色面板里 —— 先到那一屏
    await goNav('调色')

    // 参考图那一趟：解码回一个带 'ref' 记号的位图；采样按记号分源图 / 参考图
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(fakeDecoded('ref'))
    vi.mocked(sampleMod.samplePixels).mockImplementation(
      src => ((src as unknown as { __tag?: string }).__tag === 'ref' ? REF : SRC))
    const refInput = container.querySelector('input.presets-ref-file') as HTMLInputElement
    expect(refInput).toBeTruthy()
    const file = new File(['x'], 'ref.jpg', { type: 'image/jpeg' })
    Object.defineProperty(refInput, 'files', { value: [file], configurable: true })
    await act(async () => {
      refInput.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    // ③ 合流之后画布上的参数。六个拟合键必须**逐值等于**直接调纯函数拿到的
    //    （同一份输入、同一份代码，确定性 —— 比只断言"变没变"强）。
    const { params: matched } = matchToReference(SRC, REF)
    const after = canvasProps.props.at(-1)?.params ?? {}
    for (const k of ['temperature', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows'] as const) {
      expect(after[k], `${k} 该是拟合值`).toBe(matched[k])
    }
    // ④ 五条参与颜色的新参数：拟合的世界里它们就是 0（不归零 = 色偏悄悄混进来）
    expect(after.vibrance).toBe(0)
    expect(after.cbCyanRed).toBe(0)
    expect(after.cbMagentaGreen).toBe(0)
    expect(after.cbYellowBlue).toBe(0)
    expect(after.splitAmount).toBe(0)
    // ⑤ 两条色相**不动**（强度归零它们本来就不起作用；顺手清掉反而是丢用户挑的颜色）
    expect(after.splitHiHue).toBe(200)
    // ⑥ 清晰度 / 暗角：构图与局部细节，不在"参考图长什么样"的世界里
    expect(after.clarity).toBe(20)
    expect(after.vignette).toBe(-30)
  })

  /**
   * ★ 2026-10-05：参考图的**第二个来源**（用户：「这个用户应该有两个来源，
   * 一个是以往作品效果，一个是本地照片」）。
   *
   * 走的是**真链路**：点作品 → `fetchWorkImage`（fetch 假桩）→ File →
   * 和本地文件**同一个合流点**（假解码 → 假采样 → 真拟合）。断言和上面那条
   * 同款：六个拟合键逐值等于纯函数的结果 —— 两条来源必须落到同一片世界。
   */
  it('★ 从作品里选参考图：取的是小图（带版本号）→ 和本地文件合流进同一条拟合', async () => {
    await renderApp()
    await uploadPhoto()

    // 作品列表一条（id=7）。它的"小图"单独盖一条**真 Response** ——
    // 兜底那个 `{ blob }` 形状没有 `ok` 字段，`fetchWorkImage` 的 `!r.ok`
    // 会把它判成失败（那正是要的行为：拿不到就说话，见 App 的 matchWork）。
    withWorks([WORK(7, 1000)])
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/7/thumb?v=1000') {
        return new Response(new Blob(['img'], { type: 'image/jpeg' }))
      }
      return inner(url, init)
    })

    await goNav('调色')

    // 参考图那一趟的假解码/采样：和上面本地文件那条同款（'ref' 记号分两源）
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(fakeDecoded('ref'))
    vi.mocked(sampleMod.samplePixels).mockImplementation(
      src => ((src as unknown as { __tag?: string }).__tag === 'ref' ? REF : SRC))

    const clickEl = async (el: Element) => {
      await act(async () => {
        ;(el as HTMLElement).click()
        await new Promise(r => setTimeout(r, 0))
      })
    }
    await clickEl(container.querySelector('.presets-ref')!)                 // 展开两个来源
    await clickEl([...container.querySelectorAll('.presets-source')][0]!)   // 从我的作品里选
    await clickEl(container.querySelector('.presets-work')!)                // 那一张的缩略图

    const { params: matched } = matchToReference(SRC, REF)
    const after = canvasProps.props.at(-1)?.params ?? {}
    for (const k of ['temperature', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows'] as const) {
      expect(after[k], `${k} 该是拟合值`).toBe(matched[k])
    }
    // 取的是**小图**那条 URL（带版本号）—— 原图只是白费流量
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/works/7/thumb?v=1000')).toBe(true)
  })
})

/**
 * ★ 2026-10-03：**从操作页回门面**（用户要的那一个操作）。
 *
 * 在这一版之前这件事**做不到**：`/` 是落地页，而登录着的人一打开 `/` 就被那条
 * 自动跳转送去 `/app` —— 地址栏里敲 `/` 也进不去，自己人被关在 App 里。
 * 左栏最底下那颗「产品介绍」现在走 `/?home=1`，那条自动跳转认这个参数、让路。
 *
 * 四条一起守（少守哪一条，那颗按钮都会变成"点了没反应"）：
 *   ① 点它**真的到得了**门面（不是推过去又被撵回来）；
 *   ② 地址里留着那个参数 —— 收藏 / F5 回来还站在门面上；
 *   ③ 按后退回来也站得住（判据读的是**此刻的地址**，不是点的那一下记的标记）；
 *   ④ 没有参数时老规矩照旧：回访的人不该每次打开都撞上营销页。
 */
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
    // ⚠️ 夹具里的键**故意只有八个** —— 类型上 `Recipe['params']` 要十五个键，
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
    // ② ★ 有滤镜就不是"原样" —— 哪怕十五个参数一个都没动（这份配方就是全 ZERO）。
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
})

/**
 * 2026-09-25 加（Task 13 —— 13 个任务里的最后一个）。**「存进作品」= 存进作品集**（§3.4）。
 *
 * 四件事在这一层钉住：
 *   ① 点「存进作品」不再偷偷下载。下载挪到作品集里，由用户自己决定要哪张、存到哪
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
 *   ⑤ 配方里记的滤镜是**名字 + 强度**，不是 id（★ 2026-10-05，T12）——
 *      名字才是换一张图 / 换一次导入之后还认得出的那半。
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

/**
 * 用户管理页（Task 8，spec §3.6 / §3.2）。
 *
 * 入口是**左栏最底下那颗「个人设置」**（★ 2026-10-03 搬过去的）——
 * 在那之前它收在顶栏右上角那颗 👤 后面（§3.2，一辈子点几次，不占一级导航）。
 * 搬家的原因：用户指着顶栏那条说「**这个一行都不要**，个人设置放到首页下面」，
 * 那条横杠整个撤了（品牌名也一起下线）。顺带治好一个旧毛病 —— 顶栏
 * **只有修图页有**，所以站在作品页/对话页的人原来根本进不去设置。
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
  /** 左栏那颗「个人设置」。
   *
   *  ⚠️ **2026-10-04 起按 `aria-label` 找，不是按文字** —— 用户说
   *  「个人设置改为人物图标」，那颗按钮现在里面只有一个人物图标，
   *  `textContent` 是**空字符串**。名字搬进了 `aria-label`（还有 `title`）。
   *  按文字找的那一版不会报错，只会"找不到那颗按钮" —— 而那种红很容易被
   *  当成"页面坏了"，其实是标签换了个地方放。 */
  function accountNav(): HTMLButtonElement | null {
    return [...container.querySelectorAll('.nav button')]
      .find(b => b.getAttribute('aria-label') === '个人设置') as HTMLButtonElement | null
  }

  /** 从左栏那颗「个人设置」进去 —— 用户真会走的那一条路。 */
  async function openAccount() {
    const btn = accountNav()
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

  /** 按**行上那几个字**取一行（现在有三行：模型 / 改密码 / 注销账号）。 */
  function rowByLabel(label: string): HTMLButtonElement {
    const row = [...container.querySelectorAll('.account-row')]
      .find(r => r.querySelector('.account-row-label')?.textContent === label)
    expect(row, `没有「${label}」那一行`).toBeTruthy()
    return row as HTMLButtonElement
  }

  /** 往受控输入框里打字（和「登录这道门」里那个同一个做法）。 */
  function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
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
    // ★ 2026-10-04：**那三个字也得在**（用户看完这一页说「用户名没显示出来」）。
    //   他的测试账号正好叫「111」—— 屏幕上只有一个孤零零的数字时，读不出
    //   "这是你的用户名"。标签是**另起一格**，`.account-name` 里仍然只有名字
    //   （上面那条断言就是钉这个的）。
    expect(container.querySelector('.account-label')?.textContent).toBe('用户名')
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
    // 「0 张作品」。
    // ★ 2026-10-04：数据源从"前端拉整份作品清单自己加"换成了 `/api/me` 的
    //   `usage` —— 那边把**会话**占的空间也算进去了（会话里的原图和每一步的底
    //   也是用户的文件），前端那份只看得见作品。
    // 变异：把那一格改回写死 `0` → 这一条红。
    const MIB = 1024 * 1024
    withUsage({ count: 2, bytes: 10 * MIB })
    await renderApp()
    await openAccount()

    expect(statsText()).toMatch(/^2\s*张作品/)
    expect(container.querySelectorAll('.stat')).toHaveLength(1)
    // ★ 2026-10-05：两个数**画在图形里**（用户：「没有总用量和实际用量呀」→
    // 加了图例 → 「也要在图形中展现出来」→ 搬进图形区域 → 「我觉得应该显示
    // 剩余用量吧？」→ 「总共」换成「剩余」）。体积是服务端算的，上限 5 GiB。
    expect(container.querySelector('.usage-chart-used')?.textContent).toContain('已用 10 MB')
    // 5 GiB − 10 MB = 4.99 GiB → formatSize 一位小数 → 「5.0 GB」
    expect(container.querySelector('.usage-chart-rest')?.textContent).toContain('剩余 5.0 GB')
    expect(container.querySelectorAll('.usage-chart-dot')).toHaveLength(2)
    // 10 MB / 5 GB = 0.2% —— 远没到 80%，那条提醒不该出现
    expect(container.querySelector('.account-quota-warn')).toBeNull()
  })

  it('★ 用量饼图画的是**真比例** —— 0.2% 也配拥有它的一个小角（2026-10-05）', async () => {
    // 用户原话四连：「磁盘用量可视化一下用圆盘表示」→「立体的大一点的圆盘图表」
    // →「我想到了就是磁盘用量是一个叫做饼图的」→（发了张 Excel 3D 饼图）
    // 「第二个图是我想要设计的样子」。最后定型成 **3D 厚饼**：顶面椭圆 + 侧壁。
    // 钉两样：饼下的百分比文字、和已用扇形顶面的 `d`（几何全部由 pie3dPaths
    // 这个纯函数采样出来 —— 特征坐标的钉子在下一条用例里）。
    const MIB = 1024 * 1024
    const LIMIT = 5 * 1024 ** 3
    withUsage({ count: 2, bytes: 10 * MIB })     // 10 MB / 5 GiB ≈ 0.195%
    await renderApp()
    await openAccount()

    // ★ 第八/九/十轮：这行原来裸着 → 补主语 → 翻成**剩余**视角 → 「剩余」和数字
    // 并成同一个款式（用户：「字体和颜色应该跟数字保持一致吧」）。
    // 10 MB / 5 GiB = 0.2% 已用 → 剩余 99.8%。变异：把「剩余」两个字删掉 → 这一条红
    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 99.8%')
    // 扇形画的是"真比例套一道**可见性下限**"（2026-10-05 第七轮：0.195% 只有一根
    // 看不见的针，用户连说三轮"图上没有已用"→ 小于 5° 的按 5° 画；数字全是真的。
    // ⚠️ 别再加末端圆点/珠子 —— 第七轮加过，用户否了：「大圆圈也不好看呀」）。
    const drawRatio = Math.max((10 * MIB) / LIMIT, MIN_SLICE_RATIO)
    const d = container.querySelector('.usage-pie-used-top')?.getAttribute('d') ?? ''
    expect(d).toBe(pie3dPaths(drawRatio).usedTop)
    // 剩余那半块（蓝）也在 —— 0.2% 时它才是画面主体
    expect(container.querySelector('.usage-pie-rest-top')).toBeTruthy()
    // 远没到八成：饼不带警告类（饼和数字"一起变红"那条规矩的另一半）
    expect(container.querySelector('.usage-pie-warn')).toBeNull()
    // 变异：把比例写成写死的数（或 0）→ 前两条红
  })

  it('pie3dPaths：三档几何（0 / 五分之一 / 满）（2026-10-05）', () => {
    // 采样出来的点串很长，钉**特征点**（坐标手算）+ 侧壁的有/无。
    // 椭圆参数：圆心 (60,52)、rx 48、ry 28、厚度 16；12 点起笔顺时针。
    const p0 = pie3dPaths(0)
    expect(p0.usedTop).toBeNull()                 // 一点没用 → 没有扇形
    expect(p0.usedSide).toBeNull()
    expect(p0.restTop).toContain('L60.00 24.00')  // 整块厚饼从 12 点（52−28）起画
    expect(p0.restSide).toBeTruthy()              // 一整圈下半沿都有厚度

    const p20 = pie3dPaths(0.2)
    // 五分之一：弧扫 72°，终点在 −18° → x = 60+48·cos18° = 105.65、y = 52−28·sin18° = 43.35
    expect(p20.usedTop).toContain('L105.65 43.35')
    // 这段弧全在椭圆**前半**（y ≤ 圆心）→ 侧壁被顶面自己挡住，不画
    expect(p20.usedSide).toBeNull()

    const p75 = pie3dPaths(0.75)
    expect(p75.usedSide).toBeTruthy()             // 扫过下半沿（6 点方向）→ 有厚度

    const p1 = pie3dPaths(1)
    expect(p1.restTop).toBeNull()                 // 全满 → 没有剩余
    expect(p1.restSide).toBeNull()
    // 变异：把 ry 写成 0（拍成一条线）/ 把侧壁的"下半沿"条件写反 → 上面某条红
  })

  it('★ 剩余率不许显示成「100%」（那是句假话）—— 显示「>99.9%」', async () => {
    // 495 KB / 5 GiB ≈ 0.0094% 已用 → 剩余 99.9906%。四舍五入到一位小数就是
    // "100.0%"——读起来是"一个字节都没存"。用户在真机截图里抓到过它的**镜像**
    //（已用口径的「0.0%」）—— 同一条罪（《文案规范》：先问"这句话在什么情况下
    // 是假的？"）。第九轮口径翻成"剩余"之后，这颗钉子跟着镜像成「>99.9%」。
    withUsage({ count: 1, bytes: 495 * 1024 })
    await renderApp()
    await openAccount()

    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 >99.9%')
    // 变异：把 `>99.95` 那一档删掉（退回 toFixed(1)）→ 显示「剩余 100.0%」，这一条红
  })

  it('★ 服务端没给用量时**那一格整个不出现** —— 不硬凑 0，也不硬凑体积', async () => {
    // 「别硬凑」的具体形状：拿不到就说不出真话，那就**少说一句**（§3.6）——
    // 「0 张作品」对着一个存过 128 张的人是一句假话，而这页一进去就能看见。
    // `meUsage = null` 就是"响应里没有 usage"的形状（老后端、或者半坏的响应）。
    meUsage = null
    await renderApp()
    await openAccount()

    // 前提：这一页**真的开着**。少了它，下面"没有数字"会因为整页没渲染而假绿。
    expect(container.querySelector('.account')).toBeTruthy()
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
    expect(statsText()).toBeNull()
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)
  })

  it('★ 拿不到使用情况时**一个数字都不显示** —— 绝不退回 0', async () => {
    // ★★ 这一条就是审查说的那个 bug 的形状。审查原话：
    //   「任何有作品的人都会在自己的账号页看到『0 张作品』……这不是能力免责声明，
    //     而是关于用户数据的一句假话」（《文案规范》§3：写之前先问"这句话在
    //     什么情况下是假的？"）。
    // 变异：把「拿不到就整格不出现」改成画 0（= 第一版的行为）→ 这一条必须红。
    withUsageError('SENTINEL-数不出来')
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
    const gate = makeGate()
    meUsageGate = gate
    await renderApp()
    // 这里**不走 openAccount()** —— 它会把那两个滴答放过去，而这一条要的就是
    // "还在路上"的那一瞬间。
    const btn = accountNav() as HTMLButtonElement
    await act(async () => { btn.click() })

    expect(container.querySelector('.account')).toBeTruthy()
    expect(statsText()).toContain('…')
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)

    // 放行之后回的是"什么都没存" —— 那时候「0 张作品」就不是假话，而是事实。
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(statsText()).toMatch(/^0\s*张作品/)
  })

  /**
   * ★ 2026-10-04：用户管理页补的三件里的两件（§3.6 那张图上的 改密码／注销账号）
   * 和 §6.6 的 80% 提醒。这一页原来写着「注销账号**这一版不做**：
   * 它会连带删掉作品和文件，而"删了什么、能不能后悔"还没有定案」——
   * 现在定案了：**说清删什么、能不能后悔，再要一次确认**。
   */
  it('★ 空间用到 80% → 那一格变色 + 一句带出路的提醒（不能等满了才说）', async () => {
    // spec §6.6 原话：「等用户存不进去了才告诉他"满了"，是最糟的一种做法 ——
    // 他那一刻正想保存，你把他堵在门口。」
    // ⚠️ 张数按每张 2 MB 估（spec 自己写的「5 GB（约 2500 张）」），所以文案说"约"。
    const GB = 1024 ** 3
    withUsage({ count: 3, bytes: 4.2 * GB })   // 84%
    await renderApp()
    await openAccount()

    const warn = container.querySelector('.account-quota-warn')
    expect(warn?.textContent).toContain('还能存约')
    expect(warn?.textContent).toContain('八成')
    // 那一格"变色"的载体：饼变红、百分比红、**图里"已用"那行的数字**红（CSS 按
    // `.usage-pie-warn` 选择器上色；DOM 上钉 warn 类 + 两个元素都在）。
    expect(container.querySelector('.usage-pie-warn')).toBeTruthy()
    expect(container.querySelector('.usage-pie-pct')?.textContent).toBe('剩余 16%')   // 剩余视角：84% 已用 → 16% 剩余
    expect(container.querySelector('.usage-chart-used')?.textContent).toContain('4.2 GB')
    // 「剩余」不是摆设：84% 时它必须给出真正的余量（5 GiB − 4.2 GiB = 0.8 GiB = 819 MB）
    expect(container.querySelector('.usage-chart-rest')?.textContent).toContain('剩余 819 MB')

    // 出路是**一条真走得通的路**：点进去就是作品集（提醒不给出路 = 把人拉进没有门的房间）
    await act(async () => {
      (warn?.querySelector('.account-quota-go') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(location.pathname).toBe('/app/works')
  })

  it('★ 改密码：填完提交 → 真的打 /api/password，成功那句要说清"其他设备"', async () => {
    // §6.5：改密码 = **所有设备下线**（票的签名里掺着密码哈希），当前这台会被
    // 服务端发一张新票、不会掉。所以成功那句话必须提"其他设备"—— 不然用户
    // 在另一台机器上突然被登出，只会以为是自己点错了什么。
    await renderApp()
    await openAccount()

    await act(async () => { rowByLabel('改密码').click() })
    const form = container.querySelector('.account-form') as HTMLFormElement
    expect(form).toBeTruthy()

    await act(async () => {
      type(form.querySelector('input[name=oldPassword]') as HTMLInputElement, 'oldpassword1')
      type(form.querySelector('input[name=newPassword]') as HTMLInputElement, 'newpassword1')
    })
    await act(async () => {
      (form.querySelector('.account-submit') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    const call = fetchMock.mock.calls.find(c => c[0] === '/api/password')
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      oldPassword: 'oldpassword1', newPassword: 'newpassword1',
    })
    expect(container.querySelector('.account-msg')?.textContent).toContain('其他设备')
    // 密码框清空了（改完还留着一串密码在屏幕上，是"看着像没成功"的形状）
    expect((form.querySelector('input[name=oldPassword]') as HTMLInputElement).value).toBe('')
  })

  it('★ 注销：要**再确认一次**，那句话得说清删什么、能不能后悔', async () => {
    // 用户管理页原来那句「这一版不做」就是卡在这两件事上（见 AccountPage 的注释）。
    await renderApp()
    await openAccount()

    await act(async () => { rowByLabel('注销账号').click() })
    const danger = container.querySelector('.account-danger')
    expect(danger?.textContent).toContain('作品和照片会一起删掉')
    expect(danger?.textContent).toContain('删了就找不回来')
    // **还没按确认 —— 一个删除请求都没发**（点了会出事的按钮，不能只点一下就出事）
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false)

    // 「先不注销」把这一块收回去
    await act(async () => { (danger?.querySelector('.account-cancel') as HTMLButtonElement).click() })
    expect(container.querySelector('.account-danger')).toBeNull()

    // 再来一次，这回确认
    await act(async () => { rowByLabel('注销账号').click() })
    await act(async () => {
      (container.querySelector('.account-danger-submit') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/account' && c[1]?.method === 'DELETE'))
      .toBe(true)
    // 注销成功 = 人都不在了，和退出登录同一条出口：回登录页
    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
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

    // ⚠️ 按**行上的字**找，别拿 `.account-row` 里的第一个 —— 2026-10-04 晚改版之后
    //    列表的第一行是「用户名」（只读行），不再保证「模型」是第一个。
    const row = rowByLabel('模型')
    // ★ 右边那格写的是**别名**（§7.3 / §7.4）—— 型号名只在设置里翻开来才露。
    //   写型号名不只是难读，还等于把他用的是谁家摊在这一页上。
    expect(row.querySelector('.account-row-value')?.textContent).toBe('我的便宜货')
    expect(container.textContent).not.toContain('deepseek-chat')

    await act(async () => {
      row.click()
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

    const row = rowByLabel('模型')
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

  /**
   * ★ 滤镜（Task 10，设计 §5.1）：左栏「个人设置」里的第 4 格 + 它点进去那一页。
   *
   * 这一页是那个功能的**入口** —— 用户第一次拿到滤镜就是从这儿。它守四件事，
   * 每一件错了都不报错：
   *   · 清单的**四态**：还没到手 ≠ 空。拿空数组去顶"还没拉到"的后果是——
   *     一个导了 20 个滤镜的人进这一页先看到一句"你一个都没有"（和「0 张作品」
   *     同一个毛病，《文案规范》§3）；
   *   · 导入那条路的**三个失败点**（太大 / 解不开 / 服务端不认）各有各的话 ——
   *     都说"导入失败"的话，用户不知道该换文件、重新下载、还是改个名字；
   *   · 删除前先说清代价（`lutUsage` 回的那个 N 是那句话**唯一**的依据）；
   *   · 满 30 个时那颗导入按钮得真的按不动。
   */
  const LUTM = (id: number, over: Partial<LutMeta> = {}): LutMeta =>
    ({ id, name: `滤镜${id}`, size: 33, bytes: 240 * 1024, createdAt: 0, ...over })

  /** 多放几拍宏任务：导入那条链上有好几段 `await`（读文件 / 建 / 重拉清单）。 */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
  }

  /** 往那个藏起来的 `input[type=file]` 里塞一个文件（照 `uploadPhoto` 那个写法）。 */
  async function importFile(file: File) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input, '这一页那个藏起来的文件输入框不在').toBeTruthy()
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
    })
  }

  /** 列表里叫这个名字的那一行。 */
  const lutRow = (name: string) => [...container.querySelectorAll('.luts-row')]
    .find(r => (r.textContent ?? '').includes(name))

  /** 一行里的某颗按钮（按字找 —— 位置是排版的事，字才是用户的认知）。 */
  const btnIn = (row: Element | undefined, text: string) =>
    [...(row?.querySelectorAll('button') ?? [])]
      .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement

  it('★ 左栏点「Lut」能进那一页；导入一个 .cube 之后列表里出现它', async () => {
    // 两半都是**真行为**：那一格点得进去（地址栏跟着走 —— F5 / 收藏 / 转发都要认），
    // 以及选完一个文件之后清单里**真多出一行**（不是"按钮亮了"就算完）。
    // ★ 2026-10-06（深夜）：入口从「个人设置的调色素材那一格」换成**左栏那一支** ——
    //   用户：「这个可以从设置里面去掉了，我们的导航栏已经有了」（同一个
    //   `kind: 'luts'` 两个入口，谁都得先判断一下"这俩是不是一个地方"）。
    const SUNSET = LUTM(9, { name: 'sunset', size: 2, bytes: 1234 })
    // 清单里**什么时候**有它：导入之后 —— 拿 `createLut` 被调过没有当判据，
    // 而不是数"第几次拉"（探身进实现里数次数，加一处调用就悄悄错位）。
    // ⚠️ 基线要**当场量**：这个文件没有 `clearMocks`，`createLut` 的调用记录
    //    是跨用例活着的（同文件里 T9 那条注释提过同一个坑）。
    const importedBefore = vi.mocked(lutsMod.createLut).mock.calls.length
    vi.mocked(lutsMod.listLuts).mockImplementation(async () =>
      ({ luts: vi.mocked(lutsMod.createLut).mock.calls.length > importedBefore ? [SUNSET] : [] }))
    vi.mocked(lutsMod.createLut).mockResolvedValue({ lut: SUNSET })

    await renderApp()
    await goNav('Lut')

    expect(location.pathname).toBe('/app/luts')
    // 前提：这一页**真的开着**（少了它，下面那条会因为"整页没渲染"假绿）
    // ⚠️ 这里**不钉死那几个字**（★ 2026-10-05）：标题是用户自己定的文案，
    //   他刚把它从「滤镜」改成了「Lut」。这条断言的本意只是"这一页开着"，
    //   钉死字样的话他每改一次文案这里就红一次，而红的地方跟它要守的东西无关
    //   （文案该不该这么写是《文案规范》和人的事，不是这条测试的事）。
    expect(container.querySelector('.luts-title')?.textContent?.trim()).toBeTruthy()
    // 真的一个都没有 —— 这才是说「还没有导入过滤镜。」的时候
    expect(container.textContent).toContain('还没有导入过 Lut')

    await importFile(new File([CUBE2_TEXT], 'sunset.cube', { type: 'text/plain' }))

    // `createLut` 收到的是**名字 + 原文**：这个名字来自"文件名去扩展名"
    //（这个 cube 里没有 TITLE —— 有的话 TITLE 优先，服务端也认这一套次序）
    expect(vi.mocked(lutsMod.createLut)).toHaveBeenCalledWith('sunset', CUBE2_TEXT)
    // 清单里真多出一行，三样都在：名字 · N 级 · 体积（体积走 `formatSize`）
    const line = lutRow('sunset')
    expect(line).toBeTruthy()
    expect(line?.textContent).toContain('2 级')
    expect(line?.textContent).toContain('1 KB')
  })

  /**
   * ★ 2026-10-05：**左栏那颗「滤镜」**（用户：「把滤镜导入放到导航里吧，然后我没看到
   * 怎么去调用 lut 文件」）——他找不到那一页，也找不到**调用**的地方。
   *
   * 这一条把新开的那条路整条走一遍：左栏点「滤镜」→ 那一页 → 点「去套在照片上」
   * → 落到**调色**屏，而且面板里那一栏**是开着的**（不用再自己找一次 —— 他刚
   * 说过找不到）。少了最后那半截，新按钮只是把人送回一屏他刚才没找到东西的地方。
   */
  it('★ 左栏「Lut」进得去那一页；那儿的「去套在照片上」落到调色、而且那一栏是开着的', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [LUTM(1, { name: '黄昏' })] })
    await renderApp()
    await uploadPhoto()

    await goNav('Lut')
    expect(location.pathname).toBe('/app/luts')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('Lut')

    // 那一颗只在**真有滤镜**时出现（一个都没有时它把人送去一个空 picker，
    // 而该做的事明明是先导入 —— 见组件里那段）
    const go = [...container.querySelectorAll('.luts-go-use')][0] as HTMLButtonElement
    expect(go).toBeTruthy()
    await act(async () => { go.click(); await settle() })

    expect(location.pathname).toBe('/app/adjust')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('调色')
    // 到地方了，而且**已经是开着的**（不用再点一次「滤镜」那一行）
    expect(container.querySelector('.lut-grid')).toBeTruthy()
  })

  it('★ 清单拿不到时：那一页说**服务端那句话**，不说「还没有导入过 Lut」', async () => {
    // 「还没有导入过 Lut」对着一个导过 20 个、只是网络抖了一下的人就是句**假话**
    // （把"拿不到"编造成"你没有"）。
    // ⚠️ 第一发（App 挂载那一次）**照常给一份名单**：`useLuts` 拿到失败会在控制台
    //    留一行「滤镜清单没取回来」—— 那是别的用例的噪声，会盖住真话（给的那份是空
    //    名单，这一条量的是"那一页拿不到"，与 App 那份无关）。
    // ★ 2026-10-06（深夜）：入口从「个人设置那一格」换成**左栏那一支** ——
    //   用户把设置里那格撤了（见 `AccountPage` 那段注释）。
    vi.mocked(lutsMod.listLuts)
      .mockResolvedValueOnce({ luts: [] })
      .mockRejectedValue(new api.ApiError('UPSTREAM_FAILED', 'SENTINEL-滤镜清单拉不回来'))
    await renderApp()
    await goNav('Lut')

    // 说的必须是**服务端那句话**（原样），不是我们替它总结的
    expect(container.textContent).toContain('SENTINEL-滤镜清单拉不回来')
    expect(container.textContent).not.toContain('还没有导入过 Lut')
  })

  it('★ 还没到手的时候是「正在打开…」，不是「还没有导入过 Lut」', async () => {
    // 这一条钉的就是"不许拿空数组顶还没拉到"：那一句"你一个都没有"，
    // 只许在**真的拉到了空清单**之后说。
    const gate = makeGate<{ luts: LutMeta[] }>()
    vi.mocked(lutsMod.listLuts).mockReturnValue(gate.promise)
    await renderApp()
    // 只切页，不放行请求 —— 要的就是"还在路上"那一瞬间
    await goNav('Lut')

    expect(container.textContent).toContain('正在打开')
    expect(container.textContent).not.toContain('还没有导入过 Lut')

    // 放行 —— 这回是真的空，那句话才是事实
    await act(async () => { gate.open({ luts: [] }); await settle() })
    expect(container.textContent).toContain('还没有导入过 Lut')
  })

  it('★ 导入的三个失败点各有各的话 —— 而且都不会落到一次导入上', async () => {
    // 三条路**不能都说"导入失败"**：用户拿到那句话要知道该改什么 ——
    // 换个文件（太大 / 坏了），还是改个名字（重名）。三句都是**原样**显示
    //（太大那句是 spec §6.3 冻死的，和 `server/luts.ts` 一字不差）。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [] })
    vi.mocked(lutsMod.createLut).mockRejectedValue(
      new api.ApiError('BAD_REQUEST', '已经有一个叫「sunset」的 Lut 了，换个名字。'))
    await renderApp()
    await goNav('Lut')
    await settle()

    // ① 太大：**连读都不读**（8 MB 那个上限在前，解析在后）
    await importFile(new File([new Uint8Array(MAX_LUT_FILE_BYTES + 1)], 'big.cube'))
    expect(container.textContent).toContain('这个文件超过 8 MB 了。')
    expect(vi.mocked(lutsMod.createLut)).not.toHaveBeenCalled()

    // ② 解不开：`parseCube` 那句话本来就是给用户看的中文（这里是一份普通文本）
    await importFile(new File(['这不是滤镜'], 'x.cube'))
    expect(container.textContent).toContain('不是 .cube 格式')
    expect(vi.mocked(lutsMod.createLut)).not.toHaveBeenCalled()

    // ③ 本地过了、服务端不认（重名 / 满了 / 空间满了）—— **原样**显示它那句话
    await importFile(new File([CUBE2_TEXT], 'sunset.cube'))
    expect(vi.mocked(lutsMod.createLut)).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已经有一个叫「sunset」的 Lut 了，换个名字。')
  })

  it('★ 改名：就地展开一个输入框，提交打的是 renameLut(id, 新名字)', async () => {
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.renameLut).mockResolvedValue({ lut: { ...HUT, name: '日落' } })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '改名').click() })
    const input = container.querySelector('input[name=lutName]') as HTMLInputElement
    expect(input).toBeTruthy()
    // 预填现在的名字：改起来只动要动的那几个字（和详情页那颗「改名」同一条）
    expect(input.value).toBe('黄昏')

    await act(async () => { type(input, '日落') })
    await act(async () => {
      (container.querySelector('.luts-rename button[type=submit]') as HTMLButtonElement).click()
      await settle()
    })

    expect(vi.mocked(lutsMod.renameLut)).toHaveBeenCalledWith(7, '日落')
  })

  it('★ 删除：先问"还有几条会话在用"，那句话里的 N 对得上；确认了才真删', async () => {
    // 删除前那次 `lutUsage` 是确认块里那个 N 的**唯一**依据（spec §6.4）——
    // 猜一个数、或者干脆不说，都是在让用户闭着眼睛删。
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.lutUsage).mockResolvedValue({ sessions: 2 })
    vi.mocked(lutsMod.deleteLut).mockResolvedValue({ ok: true })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '删除').click(); await settle() })

    expect(vi.mocked(lutsMod.lutUsage)).toHaveBeenCalledWith(7)
    const ask = container.querySelector('.luts-ask')
    expect(ask?.textContent).toContain('还有 2 条老会话在用这个 Lut')
    expect(ask?.textContent).toContain('变回没有 Lut 的样子')
    // **还没删**：点「删除」只是把代价摊开，删除请求一条都还没发
    expect(vi.mocked(lutsMod.deleteLut)).not.toHaveBeenCalled()

    await act(async () => {
      (ask?.querySelector('.luts-delete') as HTMLButtonElement).click()
      await settle()
    })
    expect(vi.mocked(lutsMod.deleteLut)).toHaveBeenCalledWith(7)
  })

  it('★ 没人用这个滤镜时，确认块说的是「删了就找不回来了。」', async () => {
    // 两句话的分界就是 `sessions > 0` —— 对着一个没人用的滤镜说"还有老会话在用"
    // 同样是假话（只是方向相反）。
    const HUT = LUTM(7, { name: '黄昏' })
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.lutUsage).mockResolvedValue({ sessions: 0 })
    await renderApp()
    await goNav('Lut')
    await settle()

    await act(async () => { btnIn(lutRow('黄昏'), '删除').click(); await settle() })

    const ask = container.querySelector('.luts-ask')
    expect(ask?.textContent).toContain('删了就找不回来了。')
    expect(ask?.textContent).not.toContain('老会话')
  })

  it('★ 满 30 个：导入按钮禁用，还说一句「最多 30 个 Lut」', async () => {
    // 上限是 `MAX_LUTS`（服务端也拦，但拦下来是一趟白跑的请求）。
    // 只禁按钮不说话，用户只会以为按钮坏了 —— 两句要一起。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({
      luts: Array.from({ length: 30 }, (_, i) => LUTM(i + 1)),
    })
    await renderApp()
    await goNav('Lut')

    const btn = container.querySelector('.luts-import') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain('最多 30 个 Lut')
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
  /** 打到会话那两条路上的请求（建会话 / 每一步更新）。 */
  const sessionCalls = (url: string, method: 'POST' | 'PUT') =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method)

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
    // ★ 参数单独走的那条路：它落在**最后一步**上，不是靠 history 带过去的
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
    //   变异：建会话成功后不记 `lastPersistedBaseSeqRef`（或者记成 `++` 之前
    //   的那一版）→ 这两句红。
    expect(body.base).toBeUndefined()
    expect(body.thumb).toBeUndefined()
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
    // ★ 变异：改回 `el.toDataURL('image/jpeg', 0.9)` → 这里变成 `canvas:…`，红
    expect(body.base).toBe('original:画布')
    // 缩略图照旧跟着换（列表上要显示"最后那张"的样子）
    expect(body.thumb).toContain('thumb:')
  })
})

/**
 * 打开就接着上次那条（Task 5，spec §6.2）。
 *
 * 这一层错了**不会报错**，只会安静地少东西：屏幕上回到"选一张照片"（用户以为
 * 上次白干了），或者更糟 —— 图和话都回来了，屏幕上却**没有一句话说明这是上次的**，
 * 用户于是以为照片是刚上传的（§6.2 把这句话写成硬要求，就是为了这个）。
 *
 * 还有一处最贵、也最容易静静坏掉的地方：恢复出来的会话**手里没有那个 File**，
 * 而「保存 / 分享 / 下载」三条路共同的开头（`exportCurrent`）要求有它 ——
 * 少了它两边都不报错，只是三颗按钮**一起点了没反应**。下面第一条钉着它。
 */
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

  it('★ 跳到旧步骤 → 不把"现在这一版参数"写到服务端的**最后一步**上', async () => {
    // 服务端把 `patch.params`/`patch.lut` 写在**最后一步**上
    // （`server/sessions.ts` 的 `handleUpdateSession`）。跳转会把 App 里的
    // params 换成旧步骤的 —— 照旧送上去的话，服务端就把**旧步骤的参数**
    // 写进了最新那一步：刷新之后画面是最新的、滑块是旧的，谁都不报错。
    // 变异：patch 里无条件带上 params/lut → 下面两句红。
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    await renderApp()

    const nodes = [...container.querySelectorAll('.strip-node')] as HTMLButtonElement[]
    await act(async () => { nodes[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/7').at(-1)!)
    // ① 步骤还是全部（跳转不删）—— id 是 1、3、5
    expect((body.steps as { id: number }[]).map(s => s.id)).toEqual([1, 3, 5])
    // ② "现在这一版参数"没送（服务端那边 = 不动）
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

    // 而且补缩略图那个 effect **不会**再往上叠：它只认 `history` 最后一步，
    // `last.thumb` 非空就该收手（不收手的话每次落盘都会重算一遍）。
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
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await renderApp()
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

    // 在 A 里**换一次底图**（生成式编辑）—— 只有 `changed === true` 的那趟
    // 才走画布这条腿，光说话那种（changed=false）钉不到这个洞。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    await say('把后面那个人去掉')      // ← 生成已经落地（底图换了）；**故意不等 waitPersist**

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
    const putsA = putCalls('/api/sessions/9')
    expect(putsA).toHaveLength(1)
    const bodyA = bodyOf(putsA[0]!)
    expect(bodyA.base).toBeDefined()
    // 走的是 `bitmapToDataUrl` 那条（画布直出的假货是 `canvas:…`，测试台上分得开）
    expect(bodyA.base).toBe('original:画布')
    // 顺带：切过去那条照旧接回来（切走本身没被这趟影响）
    expect(bubbleTexts()).toContain('S7-用户说的')
    expect(putCalls('/api/sessions/7')).toHaveLength(1)
  })

  it('★★ 切走之后 A 那趟落盘才回来 —— 记号不许被拨回去（B 的下一次落盘不许重传底图）', async () => {
    // 2026-10-01 评审抓到的 Minor：`if (changed) lastPersistedBaseSeqRef.current = sending`
    // 这句原来没有"我回来时还是不是当时那条"的判据。而**切走前 flush**（同一轮加的）
    // 让"A 的应答在切走之后才回来"从"几乎撞不上"变成常事：A 的应答把记号拨回 A 的
    // 版本号 → B 的下一次落盘以为底图换了 → **重传一整张服务端手里已经有的底图**
    // （外加一次缩略图重做 + 服务端把好好的缩略图删了重存，§4.3 那条的落点）。
    // 不丢数据、不错内容 —— 纯粹白花流量、多存一份没人引用的文件。
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

    // 在 A 里**换一次底图**（生成式编辑）—— 只有 `changed === true` 的那一趟
    // 才写得到那个记号；"改一句话"那种（changed=false）根本写不到它，钉不住这个洞。
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
      // ★ 变异：把守卫拿掉（回到 `if (changed) ...`）→ 这里红
      //   （body.base 是一整张 data URL，body.thumb 也跟着在）。
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

/**
 * 滤镜（★ 2026-10-05，设计 §5.2 / §6.4 客户端那半）。
 *
 * 这一层守的是**接线的几件事，每一件错了都不报错**：
 *   · 选了滤镜之后**落盘**的 patch 里带不带它（漏了 → 刷新回到没滤镜的样子）；
 *   · 「重置」清不清它（不清 → 按了重置画面还是那套颜色）；
 *   · 恢复会话时最后一步的 lut 跟不跟着回来（不跟 → 刷新掉一层）；
 *   · 换一张照片清不清它（不清 → 新照片上盖着上一张的滤镜）；
 *   · "服务端上这个滤镜被删了"（`dropGoneLut`）：状态、历史、话，三样一起。
 */
describe('滤镜', () => {
  const HUT: LutMeta = { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }

  /** 点一下 + 让 React 把状态刷完（和 `goNav` 里那一下同款）。 */
  const click = async (el: HTMLElement) => {
    await act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })
  }
  /** 这一趟落盘的那笔 PUT 的请求体（最后一笔）。 */
  const lastPutBody = () => {
    const puts = fetchMock.mock.calls.filter(([u, init]) =>
      String(u).includes('/api/sessions/') && (init as RequestInit | undefined)?.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
    return bodyOf(puts[puts.length - 1]!)
  }
  /**
   * 演"人走到另一条网址上"。`/app/luts` 那一页本身是 T10 的活（这一轮还没有），
   * 但**「离开那一页时刷新清单」这条接线是这一轮的** —— 网址 + `popstate`
   * 就够把它走到（`view` 本来就是从网址推出来的）。
   */
  const gotoPath = async (path: string) => {
    await act(async () => {
      window.history.pushState(null, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
  }
  /** 按「新的一张」—— 它是"换一张照片"那条路上**唯一**的入口（`resetEditor`）。 */
  const newOne = () => click([...container.querySelectorAll('.actions button')]
    .find(b => (b.textContent ?? '').includes('新的一张')) as HTMLButtonElement)

  it('★ 微调区选中一个滤镜后：格子亮着、落盘的 patch 里带着它', async () => {
    // 变异：落盘那条 `patch` 少写一个 `lut`（或依赖数组里少了它）→ 最后那句红。
    // 两者都是静默的：屏幕上格子亮得好好的，刷新一下那层滤镜就没了。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))

    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
    await waitPersist()
    const body = lastPutBody()
    // 满强度：选中一个滤镜的默认强度是 100（用户再自己拖）
    expect(body.lut).toEqual({ lutId: 1, amount: 100 })
    // 而它**没有**新推一步快照 —— 套滤镜和拖滑块同级，不产生步骤（裁定 ⑤）
    expect(body.steps).toHaveLength(1)
  })

  it('★ 「重置」把滤镜也清掉', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    await click(adjustPanel().querySelector('.panel-head button') as HTMLButtonElement)

    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 恢复一条会话时，最后一步的滤镜跟着回来（强度也回得来）', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])

    await renderApp()
    await goNav('调色')
    await openLutPanel()

    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
    // 强度那根只在这一组里找（全屏有十五条别的滑块）
    const range = lutSection().querySelector('input[type="range"]') as HTMLInputElement
    expect(range.value).toBe('80')

    // 接回来不算完：这一版落盘时，**那一步的 `lut` 也要按 `SessionStep` 的形状
    // 跟着上路**（它就是线上那一份形状）。
    // ⚠️ 别把它读成"服务端靠它存滤镜"：`server/sessions.ts` 的 `mergeSteps` 对
    // **库里已有的 id** 是 `if (old) { out.push(old); continue }` —— 原样保留库里
    // 那条、客户端送来的这一步一个字都不采纳（2026-10-05 审查更正过一次）。
    // 这条断言守的是**载荷形状**：形状里少一个字段，哪天服务端改成"客户端赢"、
    // 或者一次 PUT 带好几个新步骤，就是静默丢滤镜（今天它顶多是白送一个没人看的字段）。
    // 变异：`snapshot` 那个映射里去掉 `lut:` → 这一句红。
    await waitPersist()
    expect((lastPutBody().steps.at(-1) as { lut?: unknown }).lut)
      .toEqual({ lutId: 1, amount: 80 })
  })

  it('★ 换一张照片 = 滤镜清掉', async () => {
    // `resetEditor` 是「新的一张」和「上传新照片」共同的那道门 —— 它不清滤镜的话，
    // 上一张的滤镜会盖在**新照片**上，而屏幕上没有任何东西说明这件事。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    await newOne()          // 回到"选一张照片"那一屏（同时也是清空这道门）
    await uploadPhoto()     // 第二张
    await goNav('调色')
    await openLutPanel()

    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 「回到这一步」跟着那一步把滤镜也还原（和参数对称）', async () => {
    // 2026-10-05 审查 Important-2：`params` 在 `onJump` 里是还原的，滤镜一开始没有 ——
    // 用户看得见两处对不上：① 每个气泡上的小图是**从带滤镜的画面上**抓的，跳回去
    // 之后主画面和那张小图不一致；② 「原图」那一步永远是 `lut: null`，而「回到原图」
    // 却留着那层颜色 —— 那已经不是原图了。
    // 变异：`onJump` 里去掉 `setLut(target.lut)` → 下面最后两句红。
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })

    await renderApp()
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')   // 前提：在用

    // 跳回原图：走照片区的**转盘**（它只在修图那一屏有）
    await goNav('修图')
    const nodes = container.querySelectorAll('.strip-node')
    await click(nodes[0] as HTMLButtonElement)          // 第 0 格 = 原图那一步

    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 「再来一版」记的是**那一步**的滤镜，不是手上现在这个', async () => {
    // 2026-10-05 复审 Important-3（新）：`onRerun` 先 `onJump(id)`、再在**同一个
    // 处理器里**调 `runGenerate` —— 而 `setLut(target.lut)` 是个 state 更新，
    // 这一轮渲染里不生效：`runGenerate` 闭包里的 `lut` 还是**跳转前**那个值。
    // `params` 没这个毛病，因为它是**显式传参**（`target.params`）—— lut 也得这么走。
    //
    // 下面这一版场景：第 2 步（id 3）**带着**滤镜、最后一步没有（所以恢复之后
    // "手上"是无滤镜）。从第 2 步重掷 → 新那一步该记的是**第 2 步的**滤镜。
    // 变异：`runGenerate` 不收 `lut` 参数、照旧用闭包里那个 → 新步骤记成 null，红。
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[1]!.lut = { lutId: 1, amount: 60 }       // 第 2 步那层颜色
    withSessions([s])
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await renderApp()
    await goNav('修图')                               // 「再来一版」在对话区
    const reruns = container.querySelectorAll('.bubble-rerun')
    // 第 0 颗 = 第 2 步（id 3，第一颗带 prompt 的助手气泡）
    await click(reruns[0] as HTMLButtonElement)
    // ★ 2026-10-05（Task 4）：第 2 步是**旧步骤** —— 先问一句（设计 §4.5）。
    await clickByText('继续改')
    await waitPersist()

    const body = lastPutBody()
    // 新推的那一步**记的是它自己那一步的滤镜**（重掷就是从那个状态接着走）
    expect((body.steps.at(-1) as { lut?: unknown }).lut).toEqual({ lutId: 1, amount: 60 })
    // 顺带：它和"当前这一版参数该落成什么"是同一个值（同一步的两面）
    expect(body.lut).toEqual({ lutId: 1, amount: 60 })
  })

  it('★ 服务端上这个滤镜被删了 —— 状态、历史、话，三样一起收拾', async () => {
    // 用户手上这张照片正用着「黄昏」（它落在**接回来的最后一步**上），他跑到
    // `/app/luts` 把那个滤镜删了再回来接着改（设计 §6.4 客户端那半）。
    //
    // ⚠️ 为什么非得走"恢复"这条路：快照里的 `lut` 是**按步**记的，而光在微调区
    //    选一下只会改 App 的 `lut` 状态、**不推快照**（裁定 ⑤）—— 那种走法下
    //    `history` 里根本没有这个 id，历史那一半的清理就成了**空的**（测不到）。
    //    从服务端接回来的会话，最后一步是真带着 lut 的，这一步才咬得住。
    //
    // 变异：`dropGoneLut` 里去掉 `setHistory(…)` 那一行 → 下面 ② 红。
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])
    vi.mocked(lutsMod.listLuts)
      .mockResolvedValueOnce({ luts: [HUT] })      // App 挂载那一次：还在
      .mockResolvedValue({ luts: [] })             // 离开设置页那一次：已经删了

    await renderApp()
    await goNav('调色')
    await openLutPanel()
    // 前提：它真的在用（不然下面那几句守的是个没发生的事）
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    await gotoPath('/app/luts')
    await goNav('修图')                            // 离开那一页 → 刷新清单 + 照镜子

    // ① 说一句 —— 那张照片上少了一层颜色，不说是"看着对、其实被悄悄改了"
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('刚被你删掉了')
    await waitPersist()
    // ② 状态清了、历史也清了：这一趟落盘里没有任何一处还提着那个 id
    const body = lastPutBody()
    expect(body.lut).toBeNull()
    expect(body.steps.every((x: { lut?: unknown }) => !x.lut)).toBe(true)
    // ③ 清单里已经没有它了
    await goNav('调色')
    await openLutPanel()
    expect(adjustPanel().textContent ?? '').toContain('还没有导入过 Lut')
  })

  /**
   * ★ Task 9（用户拍板"两个都要"）：对话区也能调滤镜。
   *
   * 说话那条路是 Task 11 的事。这一条守的是**那颗按钮**：它点开必须是
   * **和微调区同一套格子**（同一个 `LutPicker`）—— 两处各写一套的话，
   * 改了这边忘了那边，用户会在两个地方看到不一样的滤镜列表。
   */
  it('对话区那颗「滤镜」点开是同一套格子', async () => {
    // ⚠️ 必须显式设一次：这个文件没有 `clearMocks`，mock 状态跨用例活着，
    //    上一条（"服务端上这个滤镜被删了"）最后留了 `{ luts: [] }` 当默认值。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await renderApp()
    await uploadPhoto()
    // ★ 2026-10-05：它现在住在**输入框那颗加号**里（用户：「在对话框那边设一个加号，
    //    然后点击加号里面有滤镜以及以后添加的功能」）—— 先点加号，再点「滤镜」。
    const btn = await openChatTool('Lut')
    expect(btn).toBeTruthy()
    expect(container.querySelector('.chat-lut .lut-picker')).toBeTruthy()
    expect(container.querySelectorAll('.chat-lut .lut-tile')).toHaveLength(2)   // 不用 + 黄昏
  })

  /**
   * ★ 2026-10-05：**输入框那颗加号**（用户截图 + 原话：「我觉得在对话框那边设一个
   * 加号，然后点击加号里面有滤镜以及以后添加的功能」）。
   *
   * 三件事各自会静默坏掉，所以一条里都走一遍：
   *   ① 加号在那一行里、一开始**什么都没展开**（别一进来就摊开一整排）；
   *   ② 点加号 → 出现「滤镜」这一项，但**格子还没出来**（工具行 ≠ 工具本身）；
   *   ③ 再点加号 → **连展开的工具一起收**（不然格子会留在那儿、没有关它的地方
   *      —— 加号是这一摊唯一的开关）。
   */
  it('★ 加号：点开是工具行，再点是连工具一起收', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await renderApp()
    await uploadPhoto()

    expect(container.querySelector('.chat-plus')).toBeTruthy()
    expect(container.querySelector('.chat-tool')).toBeNull()
    expect(container.querySelector('.chat-lut')).toBeNull()

    await click(container.querySelector('.chat-plus') as HTMLButtonElement)
    expect(container.querySelector('.chat-tool')?.textContent).toContain('Lut')
    expect(container.querySelector('.chat-lut')).toBeNull()   // 工具行 ≠ 工具本身

    await click(container.querySelector('.chat-tool') as HTMLButtonElement)
    expect(container.querySelector('.chat-lut .lut-picker')).toBeTruthy()

    await click(container.querySelector('.chat-plus') as HTMLButtonElement)
    expect(container.querySelector('.chat-lut')).toBeNull()
    expect(container.querySelector('.chat-tool')).toBeNull()
  })

  /**
   * ★ Task 11（说话那条路）：说一句话也能套上/摘掉滤镜。
   *
   * 两半都是**接线**，各自会静默失灵：① `send` 不带清单 → 模型根本不知道
   * 用户导过什么，它只能编名字（编出来的对不上号）；② `applyDecision` 不落地
   * `decision.lut` → 决策回来了、格子纹丝不动。
   */
  it('说「用黄昏滤镜」→ 格子亮起来', async () => {
    // ⚠️ 必须显式设一次：这个文件没有 `clearMocks`（`mockResolvedValue` 的实现
    //    跨用例活着），依赖清单的用例都自己盖一份。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'params', lut: { name: '黄昏', amount: 100 } }))

    await renderApp()
    await uploadPhoto()
    await say('用黄昏那个滤镜')

    // ① 请求里带着清单（模型就是靠它认名字的）
    const req = vi.mocked(api.postRoute).mock.calls[0][0] as {
      luts?: { id: number; name: string }[]; lut?: unknown }
    expect(req.luts).toEqual([{ id: 1, name: '黄昏' }])
    // ⚠️ 两个字段都要在：`luts` 是给模型认名字的，`lut` 是"此刻手上那个"的上下文
    expect(req.lut).toBeNull()
    // ② 格子上确实亮了（滤镜那两条 mock 见 Task 8 Step 1）
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
  })
  it('说「不要滤镜了」→ 摘掉', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'params', lut: { name: '', amount: 0 } }))

    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))
    // 前提：它真在用（不然下面守的是个没发生的事）
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    await goNav('修图')                    // 对话区在修图那一屏
    await say('不要滤镜了')

    // 先选中，再说一句 → 格子回到「不用」
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 一次说两件事（套滤镜 + 去掉路人）：那一步的快照记的是**新滤镜**', async () => {
    // 一次决策里既套滤镜又生成（route=both）时，"这一步"的状态是**做完之后**
    // 那个 —— 和 `nextParams` 完全对称。传闭包那个旧值的话，这一步的缩略图
    // （从**带新滤镜**的画布上抓的）和「回到这一步」还原出来的主画面对不上，
    // 正是 T8 修过两次的那一类静默不一致（plan「已被证伪」第 6/7 条）。
    // 变异：`applyDecision` 给 `runGenerate` 传闭包的 `lut`（不传 nextLut）→ 红。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(api.postRoute).mockResolvedValue(decision({
      route: 'both', paramDeltas: { exposure: 20 }, editPrompt: 'remove the person',
      lut: { name: '黄昏', amount: 100 },
    }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await renderApp()
    await uploadPhoto()
    await say('去掉那个人，再用黄昏滤镜')
    await waitPersist()

    const body = lastPutBody()
    // 新推的那一步记的是**决策之后**的滤镜
    expect((body.steps.at(-1) as { lut?: unknown }).lut).toEqual({ lutId: 1, amount: 100 })
    // 当前这一版该落成的也是它（同一步的两面）
    expect(body.lut).toEqual({ lutId: 1, amount: 100 })
  })

  /**
   * ★ 2026-10-05 终审修复（Important）：**清单"取不到"不是"清单是空的"**。
   *
   * 旧写法里 `useLuts.reload()` 失败时回一个空数组，而 `refreshLuts` 拿它照镜子 ——
   * 失败场景很平常（离线 / 5xx / 后端刚重启）：用户在 `/app/luts` 上**什么都没删**，
   * 点离开那一页，这一下 `GET /api/luts` 挂了 → 当帧把用户手上的滤镜清掉、
   * 把历史里那几步的 `lut` 也清掉、还告诉他「那个滤镜刚被你删掉了」——
   * 而清单里那条**还在**（`setLuts` 根本没被调用）：屏幕上"格子里有它、当前却是不用"，
   * 下一次落盘还会把 null 写回服务端。
   */
  it('★ 刷新清单**失败**时什么都不照：不许把还在的滤镜当成"刚被删掉了"', async () => {
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])
    vi.mocked(lutsMod.listLuts)
      .mockResolvedValueOnce({ luts: [HUT] })     // App 挂载那一次：还在
      .mockRejectedValue(new api.ApiError('UPSTREAM_FAILED', 'SENTINEL-清单拉不回来'))  // 离开那一页那一次：挂了

    await renderApp()
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')   // 前提：它真在用

    await gotoPath('/app/luts')
    await goNav('修图')                            // 离开那一页 → 刷新清单（这一发失败）

    // ① 不许说那句假话（"刚被你删掉了"是**用户会照做**的一句通报）
    expect(container.querySelector('.notice')?.textContent ?? '').not.toContain('刚被你删掉了')
    // ② 手上那层还在：格子照旧亮着
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
    // ③ 历史里那几步也没被清（落盘的那份还是它）
    await waitPersist()
    expect(lastPutBody().lut).toEqual({ lutId: 1, amount: 80 })
  })

  /**
   * ★ 2026-10-05 终审修复（Important）：滤镜文件取不回来时要**说得出口**。
   *
   * 旧写法：`lutFileText` 扔裸 Error、`useLuts` 吞成一行 console ——
   * 用户看到的是"格子亮着、画面不变、一句话都不说"，再点同一格也不重试
   * （取 cube 那条 effect 的依赖是 `lutId`，没变）。
   */
  it('★ 滤镜文件取不回来：通报一句（不是"格子亮着、画面没变、一声不吭"）', async () => {
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(lutsMod.lutFileText).mockRejectedValue(
      new api.ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？'))

    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))

    expect(container.querySelector('.notice')?.textContent ?? '').toContain('没取回来')
    // ⚠️ 还原默认：这个文件没有 `clearMocks`，mock 状态跨用例活着 ——
    //    留着这发失败的实现，后面任何"cube 该取得回来"的用例都会踩到它。
    vi.mocked(lutsMod.lutFileText).mockResolvedValue(CUBE2_TEXT)
  })

  /**
   * ★ 2026-10-05 终审修复（Important）：面板分不出"还没到手 / 取不到"和"真的没有"。
   *
   * 「还没有导入过滤镜。」是**关于用户资产的一句陈述**，只许在服务端真的回了
   * 空清单时说。触发场景很平：App 挂载那次 `listLuts()` 失败（离线 / 后端刚重启 /
   * 页面里重新登录过）→ 面板永远空态、**而且没有重试的口子**。
   */
  it('★ 清单取不到：面板不说「还没有导入过 Lut」，那颗「再试一次」真的接在重拉上', async () => {
    vi.mocked(lutsMod.listLuts)
      .mockRejectedValue(new api.ApiError('UPSTREAM_FAILED', 'SENTINEL-清单拉不回来'))
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()

    const text = () => adjustPanel().textContent ?? ''
    expect(text()).not.toContain('还没有导入过 Lut')
    expect(text()).toContain('还没到手')

    // 服务端缓过来了 —— 点那颗「再试一次」，清单真的到手、格子出来
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    await click(adjustPanel().querySelector('.lut-import-go') as HTMLButtonElement)
    expect(tileNamed('黄昏')).toBeTruthy()
    expect(text()).not.toContain('还没到手')
  })
})

/**
 * ★ 2026-10-05：「回到这一步」不再删后面的步骤（用户原话：「用户点击回到
 * 这一步后，应该保留更改的那一步」）。
 *
 * 这一条守的是**用户看得见的那件事**：跳回去之后后面的图和按钮一个不少。
 * 变异：`onJump` 里把 `cutAfter` 那一套加回去 → 第一条当场红。
 */
describe('「回到这一步」不再删后面的步骤', () => {
  /**
   * 一步一格 —— ★ 2026-10-06（晚）：判据从对话里那两颗文字提示
   * （`.bubble-jump` / `.bubble-current`）换成了**转盘上的格子**。
   * 顺序 = 步骤顺序（原图在最前），点一格 = `onJump`；站着那格是 `<span>`。
   */
  const stepItems = () =>
    [...container.querySelectorAll<HTMLElement>('.strip-node')]
  const bubbleTexts = () =>
    [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')

  /** 上传 + 生成两版：history = [原图, 第 1 版, 第 2 版]，对话 5 条。 */
  async function twoVersions() {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('再改一次')
  }

  it('★ 跳到旧步骤 → 后面的图和按钮一个不少，还能再点回去', async () => {
    await twoVersions()
    expect(stepItems()).toHaveLength(3)      // 原图 + 两次生成

    // 退回原图
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    // ⚠️ 原图那张位图**不在 `decodedBitmaps` 里** —— 那份只收 `createImageBitmap`
    //    解出来的（生成回来的图、恢复回来的步骤），而原图走的是 `decodeImageFile`，
    //    记号是 `upload`。所以按 `__tag` 认（`canvasProps.images` 的类型只有
    //    width/height，读 `bitmap` 得这样写 —— 这个文件里那几处都是同一个路数）。
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })  // 画面回到原图

    // ★ 后面两步**还在** —— 一步一个（按钮/标记）、时间轴上的格子一格不少
    expect(stepItems()).toHaveLength(3)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(3)

    // ★ 2026-10-05（终审小项）：**直接**守卫"位图没被提前释放" —— 上面数的是
    //   按钮和小图（DOM 层的证据），这两行问的是那两个位图**自己**：`close`
    //   一次都没被调过（`fakeBitmap` 的 `close` 是 `vi.fn()`）。
    //   变异：`onJump` 里把"被切掉的位图 `close()`"加回去 → 这两行当场红。
    expect(decodedBitmaps[0]!.close).not.toHaveBeenCalled()
    expect(decodedBitmaps[1]!.close).not.toHaveBeenCalled()

    // 而且还能再跳回去（点最后一个 = 第 2 版）
    await act(async () => { stepItems()[2]!.click(); await new Promise(r => setTimeout(r, 0)) })
    const back = canvasProps.images.at(-1) as unknown as { bitmap: ImageBitmap }
    expect(back.bitmap).toBe(decodedBitmaps[1])
  })

  it('★ 从旧步骤再生成 → 后面的步骤和那一段对话一起被切；**刚说的那句话留着**', async () => {
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })

    await say('换个方向')
    // ★ 2026-10-05（Task 4）：从旧步骤生成要先点一下「继续改」才真的动手。
    await clickByText('继续改')

    // 新的一条是从**原图**改的
    const last = vi.mocked(api.postEdit).mock.calls.at(-1)![0] as { imageDataUrl: string }
    expect(last.imageDataUrl).toContain('MODEL:upload')

    // ★ 旧未来那一段对话没了（连用户当时说的话一起收）
    expect(bubbleTexts()).not.toContain('先改一次')
    expect(bubbleTexts()).not.toContain('再改一次')
    // ★ 但**刚说的这句**必须活着 —— 一刀切 `> stepId` 会把它的 id 也切掉
    expect(bubbleTexts()).toContain('换个方向')

    // 步骤：原图 + 新那一步
    expect(stepItems()).toHaveLength(2)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
  })

  it('★ 从旧步骤生成**失败** → 后面的步骤一个不少（切只发生在成功之后）', async () => {
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })

    vi.mocked(api.postEdit).mockRejectedValue(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))
    await say('换个方向')
    // ★ 2026-10-05（Task 4）：确认之后才轮到 postEdit 抛。
    await clickByText('继续改')

    expect(lastReply()).toContain('再试一次')      // 失败要说话
    expect(stepItems()).toHaveLength(3)            // ★ 后面的没陪葬
    expect(container.querySelectorAll('.strip-node')).toHaveLength(3)
  })

  it('★ 从旧步骤再说话 → 先问一句；「算了」= 什么都没花、什么都没切', async () => {
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    vi.mocked(api.postEdit).mockClear()

    await say('换个方向')

    // ★ 条子在、钱没花（生成一个字都没发出去）
    expect(container.textContent).toContain('后面还有 2 步')
    expect(api.postEdit).not.toHaveBeenCalled()

    await clickByText('算了')

    expect(api.postEdit).not.toHaveBeenCalled()
    expect(stepItems()).toHaveLength(3)                               // 一个都没切
    expect(container.querySelectorAll('.strip-node')).toHaveLength(3)
    expect(lastReply()).toContain('那就不动这一步')                     // 有话收尾
    expect(container.textContent).not.toContain('后面还有 2 步')        // 条子收了
  })

  it('★ 「继续改」→ 到这一步才说话、才生成、才切', async () => {
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    vi.mocked(api.postEdit).mockClear()

    // ★ 2026-10-05（Task 5 carry-over）：这句 reply 特意跟默认那句（'好。'）不同
    //   —— 原来断的 `toContain('好')` 太松，屏幕上任何一句带"好"的话都能让它过
    //   （同批另两条断的是 '那就不动这一步' 这种精确短语）。换成只可能来自
    //   这一句的片段，下面才有资格说"是**这句 reply** 到这时才说"。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好，这就换个方向改。' }))
    await say('换个方向')

    // 还挂在确认条上：这句 reply **一个字都还没说**（说了再点「算了」就是"说了不做"）
    expect(bubbleTexts()).not.toContain('好，这就换个方向改。')
    await clickByText('继续改')

    expect(api.postEdit).toHaveBeenCalledTimes(1)
    const req = vi.mocked(api.postEdit).mock.calls.at(-1)![0] as { imageDataUrl: string }
    expect(req.imageDataUrl).toContain('MODEL:upload')                // 从原图改的
    expect(bubbleTexts()).not.toContain('先改一次')                    // 旧未来切了
    expect(bubbleTexts()).toContain('换个方向')                        // 刚说的还在
    expect(lastReply()).toContain('这就换个方向改')                     // 那句 reply 到这时才说
  })

  it('★ 确认条挂着时跳走 → 条子收了（不会切到别处）', async () => {
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await say('换个方向')
    expect(container.textContent).toContain('后面还有 2 步')

    // 跳到最后一个步骤（按钮和标记合着数，`.at(-1)` 两种世界下都是可点的那颗）
    await act(async () => { stepItems().at(-1)!.click(); await new Promise(r => setTimeout(r, 0)) })
    // ⚠️ 断的是「后面还有」整句，不是「后面还有 2 步」：跳到最后一步之后
    //    `futureSteps` 本来就会变 0（条子会改口说"0 步"）—— 断那个数字的话，
    //    `onJump` 里漏掉 `cancelReplace()` 这条**根本红不了**（实测过），
    //    而漏掉它的后果是：条子停着还能点，「继续改」切的是**已经跳走的那一步**。
    expect(container.textContent).not.toContain('后面还有')
  })

  it('★ 确认条挂着时切到另一条会话 → 条子收了（不会切在别人那条上）', async () => {
    // 「换照片」那一类失效（`loadSession` 里那批"上一条照片的临时状态"）：
    // 切会话 = 屏幕上换了一张照片。不清的话，条子会停在**别人那条**会话上
    // —— N 按新的 history 算（甚至算出 0），点「继续改」切的是 B 的步骤。
    const a = { ...makeSession(9, 3, 'A 的话', 'TA'), originalName: '九号.jpg' }
    const b = { ...makeSession(7, 3, 'B 的话', 'TB'), originalName: '七号.jpg' }
    withSessions([a, b])
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下' }))

    await renderApp()                                  // 接回最近动过的那条（A = id 9）
    const steps = [...container.querySelectorAll<HTMLElement>('.strip-node')]
    await act(async () => { steps[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await say('换个方向')
    expect(container.textContent).toContain('后面还有 2 步')

    // 走真入口切到 B：左栏「对话」→ 点「七号」那一行
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await waitPersist()
    await goNav('修图')

    expect(container.textContent).not.toContain('后面还有')
  })

  it('★ 站在最新一步说话 → 不弹条（正常流程一个字都没多）', async () => {
    await twoVersions()
    await say('再改一次')
    expect(container.textContent).not.toContain('后面还有')
    expect(api.postEdit).toHaveBeenCalledTimes(3)
  })

  it('★ 旧步骤上点「再来一版」→ 同样先问；最新一步上直接重掷（不弹条）', async () => {
    await twoVersions()
    const reruns = () =>
      [...container.querySelectorAll('.bubble-rerun')] as HTMLButtonElement[]
    vi.mocked(api.postEdit).mockClear()

    // 旧步骤（第 1 版）→ 先问
    await act(async () => { reruns()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).toContain('后面还有 1 步')
    expect(api.postEdit).not.toHaveBeenCalled()

    await clickByText('继续改')
    expect(api.postEdit).toHaveBeenCalledTimes(1)

    // 最新一步 → 直接重掷，没有条子
    vi.mocked(api.postEdit).mockClear()
    await act(async () => { reruns().at(-1)!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.textContent).not.toContain('后面还有')
    expect(api.postEdit).toHaveBeenCalledTimes(1)
  })

  it('★ 站的那一格在转盘上标出来；跳走之后标记跟着走', async () => {
    await twoVersions()

    // 站在最新一步：转盘上**最末一格**是那格位置标记（`<span>`，点不动）
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes().at(-1)!.className).toContain('current')
    expect(nodes().at(-1)!.tagName).toBe('SPAN')
    expect(container.querySelectorAll('.strip-node.current')).toHaveLength(1)

    // 退回原图：标记跟到**第一格**上
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(nodes()[0]!.className).toContain('current')
    expect(nodes()[0]!.tagName).toBe('SPAN')
    expect(container.querySelectorAll('.strip-node.current')).toHaveLength(1)
    // 而且刚才那格（第 2 版）变回了按钮 —— 后面的步骤还能往回跳
    expect(nodes().at(-1)!.tagName).toBe('BUTTON')
  })

  it('★（I1）站在旧步发话、路由还在路上就跳回最新一步 → 不弹条、照常生成', async () => {
    // 参考：`cursorIdRef`（App.tsx）。
    // `send` 从发出到 `applyDecision` 隔着 `prepareForRouting` + `postRoute` 两段
    // await（实测 1.3~1.6 秒），而「回到这一步」有意**没有 busy 闸门** —— 这条
    // 用例演的就是那段窗口里用户点一下跳转。
    // 变异：`applyDecision` 读 state（闭包里的旧位置）→ 闸门以为"还站在旧步骤"，
    // 弹出一条拿**新**位置算出来的假提示（"后面还有 0 步，从这改会把它们去掉。"），
    // 而且这一版生成根本发不出去 —— 下面两句一起红。
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    vi.mocked(api.postEdit).mockClear()

    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await say('换个方向')                        // 卡在 postRoute 上：路由还在飞

    // 路由回来之前跳回**最新一步**（按钮和标记合着数，`.at(-1)` 是最后一颗按钮）
    await act(async () => { stepItems().at(-1)!.click(); await new Promise(r => setTimeout(r, 0)) })

    // 现在放行：决策这一刻才进来
    await act(async () => {
      gate.open(decision({ route: 'generate', editPrompt: '改一下' }))
      await new Promise(r => setTimeout(r, 0))
    })

    // 站在**最新一步**上：不用问，直接生成（条子一个字都不许有）
    expect(container.textContent).not.toContain('后面还有')
    expect(api.postEdit).toHaveBeenCalledTimes(1)
  })

  it('★（I1）站着旧步发话、路由没回来就跳到另一步 → 条子的 N 和**跳过去**那一步一致', async () => {
    // 参考：`cursorIdRef`（App.tsx）。
    // 钉的是同一个窗口的另一半：跳转之后条子上的 N 用**新**位置算，切口也得用
    // **新**位置 —— 各说各话的话，点「继续改」切的地方不是它说的那处。
    // 变异：`applyDecision` 读 state（旧位置）→ 切口落在原图上：'先改一次' 被
    // 切走、送上去的底是 `MODEL:upload` —— 下面两句红。
    await twoVersions()
    await act(async () => { stepItems()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    vi.mocked(api.postEdit).mockClear()

    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await say('换个方向')

    // 跳到**第 1 版**那一步（不是最新）—— 从它再改，后面还剩 1 步
    await act(async () => { stepItems()[1]!.click(); await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      gate.open(decision({ route: 'generate', editPrompt: '改一下' }))
      await new Promise(r => setTimeout(r, 0))
    })

    // 条子上的 N 按**跳过去**那一步算：后面还有 1 步（渲染读的是 state 里的新位置）
    expect(container.textContent).toContain('后面还有 1 步')
    expect(api.postEdit).not.toHaveBeenCalled()          // 还没点「继续改」，钱没花

    await clickByText('继续改')

    // ★ 真正钉 I1 的只有最后一行（`bubbleTexts()` 那条）：切口要用**跳过去**那一步
    //   算（`origin.stepId` 来自决策那一刻的 `cursorIdRef`）—— 变异成读 state 的
    //   旧位置的话，切点会落回原图，'先改一次' 被切走，那行当场红。
    //   ⚠️ 上面那条 `MODEL:decoded-1` **不是** I1 的守卫（措辞更正，2026-10-05）：
    //   点「继续改」走的是 `confirmReplace`，它读的是**此刻 render 的 `image`**
    //   —— 不管出发点是哪一步，那个值都是跳转后那一步的，新旧实现在它上面一模一样
    //   （实测：只按 I1 变异，它不红）。留着它只是"送的是 v1 的底"这条边角检查。
    expect(api.postEdit).toHaveBeenCalledTimes(1)
    const req = vi.mocked(api.postEdit).mock.calls.at(-1)![0] as { imageDataUrl: string }
    expect(req.imageDataUrl).toContain('MODEL:decoded-1')
    expect(bubbleTexts()).toContain('先改一次')
  })

  it('★（终审残留）路由还在飞时切到另一条会话 → 这趟作废：通报一句、不弹条、不生成、不串会话', async () => {
    // 参考：`App.tsx` `send` 里 `sidAt` / `seqAt` 那道闸。
    // `send` 从发出到 `applyDecision` 隔着两段 await（实测 1.3~1.6 秒），而
    // 切会话 / 换照片都**没有** busy 闸门 —— 这条钉的就是那段窗口里用户点开
    // 另一条会话。两条会话**步数故意相同**（都是 3 步、步骤 id 都是 1/3/5）：
    // 撞号时旧虫走的是**静默**那条 —— 站的位置恰好等于新会话的 tip，确认条
    // 都不弹，直接生成，把这张照片的生成写进另一条会话（串会话，错了不报错）。
    // 变异：去掉 `send` 里那道闸 → ①③ 当场红（屏幕上没有"切走"那句通报、
    // postEdit 被调用）。
    const a = { ...makeSession(9, 3, 'A 的话', 'TA'), originalName: '九号.jpg' }
    const b = { ...makeSession(7, 3, 'B 的话', 'TB'), originalName: '七号.jpg' }
    withSessions([a, b])
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()                                  // 接回最近动过的那条（A = id 9）

    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await say('换个方向')                               // 卡在 postRoute 上：路由还在飞

    // 走真入口切到 B：左栏「对话」→ 点「七号」那一行
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await waitPersist()
    await goNav('修图')

    // 现在放行：决策这一刻才进来 —— 它属于 A，而人已经站在 B 上
    await act(async () => {
      gate.open(decision({ route: 'generate', editPrompt: '改一下' }))
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 通报一句（说清哪一趟、还能怎么办）
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('切走')
    // ② 没有确认条 —— 尤其不许出现"后面还有 0 步"那种自相矛盾的胡话
    expect(container.textContent).not.toContain('后面还有')
    // ③ 钱没花：这一趟在闸门处就作废了
    expect(api.postEdit).not.toHaveBeenCalled()
    // ④ 新会话（B）的气泡里没有 A 那句话 —— 串会话一个字节都没发生
    expect(bubbleTexts()).not.toContain('换个方向')
  })

  it('★（终审残留）上传后立刻说话、建会话这时才回来 → 照常生成（不许拿"切走"的假话打发）', async () => {
    // 它是上面那道闸的**另一半**：`onPick` 里建会话是不 await 的（"锦上添花"，
    // `busy` 在它回来之前就清了），所以用户完全可能在建会话回来之前先说了一句。
    // 这趟出发时 `sidAt === null`，建会话回来把 `sessionIdRef` 从 null 拨成 id ——
    // 那是**同一条会话在长出来**，不是"人走了"。闸门要是连这一格也比，用户会拿到
    // 一句**假话**（他根本没走），而且刚说的那句话被扔掉（"这边没动它"）。
    // 变异：闸门写回 `sessionIdRef.current !== sidAt`（不排 null）→ 这条当场红。
    const sessionGate = makeGate<{ id: number }>()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(await sessionGate.promise)
      }
      return inner(url, init)
    })
    const routeGate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(routeGate.promise)
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()                       // 照片进来；建会话被挂住（sessionId 还是 null）
    await say('亮一点')                        // 立刻说话：出发时 sidAt === null

    // 建会话在这段路由窗口里回来：`sessionIdRef` 从 null 拨成 id
    await act(async () => {
      sessionGate.open({ id: 1 })
      await new Promise(r => setTimeout(r, 0))
    })
    // 放行路由
    await act(async () => {
      routeGate.open(decision({ route: 'generate', editPrompt: '改一下' }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.notice')?.textContent ?? '').not.toContain('切走')
    expect(api.postEdit).toHaveBeenCalledTimes(1)      // 这句话照常生效
  })
})

/**
 * ★ 2026-10-06（先是他原话：「在会话里的单条记录我怎么还是没有删除的按钮」，
 *   随后他看了豆包：「放个这个图标在每段对话的最后，点击这个符号后里面有删除选项」）。
 *
 * 入口 = **每段消息末尾那颗「…」**（排在动作行最后一个，一直看得见、不用悬停）。
 * 点开就地展开一条菜单，目前里面一项【删除】（以后加东西就往这条里排）。
 *
 * 语义（控制器问过一轮之后他选的 —— **都能删**）：
 *   · 纯文字那条（身后没有"一步"）点【删除】**直接删**，不用确认；
 *   · 带图那条（身后挂着一整步：图 / 参数 / 滤镜都在它上面）点【删除】**先就地
 *     问一句**（「删了就找不回来了。」），确认之后**连那一步一起删**；
 *   · 「原图」那条（欢迎语和它是同一条消息）不给「…」—— 它是这条会话的锚。
 *
 * 这一组钉的都是**用户看得见的行为**：菜单开合（开关、一次只开一条）、
 * 消息没了、小图少一张、画面换到哪一张、那一趟落盘送出去的是不是干净的，
 * 以及忙的时候点不动。
 */
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

    // ② 那条话**立刻**没了（身后没有一步，不用确认）
    expect(bubbleTexts()).not.toContain('这句不用改图。')
    expect(container.querySelectorAll('.msg')).toHaveLength(2)
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

    // ① 那条话没了；② 时间轴上少一格；③ 消息少一条（剩下欢迎 + 两句用户话 + 第2版）
    expect(bubbleTexts()).not.toContain('第一版好了。')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(container.querySelectorAll('.msg')).toHaveLength(4)

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

    // ① 那条话和那一步没了（时间轴 3 格 → 2 格），但**画面一动不动**（站的是第 2 版）
    expect(bubbleTexts()).not.toContain('第一版好了。')
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
    // "编辑器显示 v1、左栏列表封面是 v2"的静默不一致。根因是删除没有推
    // `baseSeqRef`（落盘那趟判"底图换过没有"的 `changed` 用的就是它）。
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
    //    变异：删除处理器里不推 `baseSeqRef` → 这一句当场红（`changed` 为假，
    //    patch 里没有 thumb）。
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

  it('勾一条算一条：点勾选框、点那条消息都能勾；再点一下取消', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    const countText = () => container.querySelector('.chat-select')?.textContent ?? ''

    await clickEl(pickBoxOf('先改一次'))
    expect(pickBoxOf('先改一次').checked).toBe(true)
    expect(countText()).toContain('已选 1 条')

    await clickEl(pickBoxOf('先改一次'))          // 再点一下 = 取消
    expect(pickBoxOf('先改一次').checked).toBe(false)
    expect(countText()).toContain('已选 0 条')

    await clickEl(bubbleOf('先改一次'))           // 点那条消息本身也能勾
    expect(countText()).toContain('已选 1 条')

    // ★ 2026-10-06（晚）：小图搬出对话区之后，"点图 = 勾选（不跳）"那个双关
    //   没有了 —— 时间轴是**纯导航**（它不在被勾的那堆东西里），选择模式下
    //   照常能跳：勾着的一条不动，只是大图换过去看一眼。
    const shown = canvasProps.images.at(-1)
    await clickEl(container.querySelectorAll<HTMLElement>('.strip-node')[0]!)  // 原图那格
    expect(canvasProps.images.at(-1)).not.toBe(shown)   // 画面真的换过去了
    expect(countText()).toContain('已选 1 条')           // 勾照样在
  })

  it('一条都没勾时【删除】是禁用的 —— 不留一个点了没用的按钮', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    expect(selectDelBtn().disabled).toBe(true)
    await clickEl(pickBoxOf('先改一次'))
    expect(selectDelBtn().disabled).toBe(false)
  })

  it('勾的全是纯文字：点【删除】直接删 —— 不问、不花钱、删完退出选择模式', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    const posts = vi.mocked(api.postEdit).mock.calls.length
    await clickEl(pickBoxOf('先改一次'))
    await clickEl(selectDelBtn())

    expect(container.textContent).not.toContain('删了就找不回来了')
    expect(bubbleTexts()).not.toContain('先改一次')
    expect(container.querySelectorAll('.msg')).toHaveLength(2)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)   // 一步没动
    expect(api.postEdit).toHaveBeenCalledTimes(posts)
    // 退出选择模式：输入框回来了、勾选框没了
    expect(container.querySelector('.chat-select')).toBeNull()
    expect(container.querySelector('.chat-input')).toBeTruthy()
    expect(container.querySelectorAll('.msg-pick')).toHaveLength(0)
  })

  it('选中的里带图：先问一句（说清几张）——「算了」什么都没变、勾还都在', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    await clickEl(pickBoxOf('先改一次'))
    await clickEl(pickBoxOf('好，改好了。'))
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
    // 两版：history = [原图(1), 第1版(3), 第2版(5)]。站在第 1 版上，把**它和一句
    // 用户话**一起勾掉 —— 剩下的最后一步是第 2 版（不是原图，"挪到前一个"那种
    // 写法会对不上）。
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
    await clickEl(pickBoxOf('先改一次'))
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
    await clickEl(pickBoxOf('第一版好了。'))
    await clickEl(pickBoxOf('先改一次'))
    await clickEl(selectDelBtn())
    await clickByText('确认删除')
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    const stepIds = body.steps.map((s: { id: number }) => s.id)
    const msgIds = body.messages.map((m: { id: number }) => m.id)
    expect(stepIds).not.toContain(3)          // 被删那一步
    expect(msgIds).not.toContain(3)           // 那句话
    expect(msgIds).not.toContain(2)           // 另一句被删的话
    expect(stepIds).toContain(1)              // 原图还在
    expect(stepIds).toContain(5)              // 第 2 版还在
    expect(JSON.stringify(body)).not.toContain('先改一次')
    expect(JSON.stringify(body)).not.toContain('第一版好了')
  })
})

/**
 * ★ 2026-10-06（用户反馈：「当用户进行提问时对话区是不会自动向下滚动的」）。
 *
 * 对话区（`.chat-log`）是一个**自己滚**的格子：内容长过它以后，新消息落在
 * 视野外面 —— 用户问了话，屏幕上却"什么都没发生"。这套"跟着走"从来没写过
 * （不是哪天改坏的），这一组把它钉住。
 *
 * 语义照主流聊天产品那一套：
 *   · **贴着底**时：新内容（自己的话 / 「正在思考…」/ 回复）出现 → 跟着往下走；
 *   · **翻到上面在看历史**时：新内容来了**不把人拽下去**（他正在读）；
 *   · **自己按下发送** = 表态"我要看最新的" → 无条件贴回底。
 *
 * ⚠️ jsdom 没有排版：`scrollTop` / `scrollHeight` / `clientHeight` 全是 0，
 *   真"滚动"根本演不出来。所以这一组给 `.chat-log` 装一份**假几何**
 *   （高 1000、可视 200、起始 scrollTop 800 = 正贴着底），拿它当断言依据 ——
 *   读写的用法和真浏览器里一模一样。
 */
describe('对话区跟着新消息往下走', () => {
  /** 给 `.chat-log` 装一份假几何（= 一个已经滚满了的对话区，正贴着底）。 */
  function fakeScroll(): HTMLElement {
    const log = container.querySelector('.chat-log') as HTMLElement
    expect(log, '屏幕上没有对话区（.chat-log）').toBeTruthy()
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(log, 'scrollTop', { value: 800, writable: true, configurable: true })
    return log
  }
  /** 演"用户自己往上翻了"（真浏览器里这会派发 scroll，监听器就是这么更新的）。 */
  async function scrollUp(log: HTMLElement) {
    log.scrollTop = 0
    await act(async () => {
      log.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 贴着底时：说一句话 / 「正在思考…」出现 —— 对话区跟着往下走', async () => {
    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await renderApp()
    await uploadPhoto()
    const log = fakeScroll()

    await say('先改一次')          // 路由被闸门挂着：用户的话 + 「正在思考…」都在了

    expect(log.scrollTop).toBe(1000)   // 800 → 1000：贴到底了

    // 放行，让这一趟收工（不留下挂着的 promise）
    await act(async () => {
      gate.open(decision({}))
      await new Promise(r => setTimeout(r, 0))
    })
  })

  it('★ 翻到上面读历史时：回复来了**不把人拽下去**；自己按发送才贴回底', async () => {
    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await renderApp()
    await uploadPhoto()
    const log = fakeScroll()

    await say('先改一次')          // 发送 = 表态要看最新的
    expect(log.scrollTop).toBe(1000)

    await scrollUp(log)            // 用户翻上去读旧消息
    expect(log.scrollTop).toBe(0)

    // 回复回来了：人在上面读着，**不许**把他拽到底
    await act(async () => {
      gate.open(decision({}))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(log.scrollTop).toBe(0)

    // 自己再按一次发送 → 无条件贴回底
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({}))
    await say('再看一眼')
    expect(log.scrollTop).toBe(1000)
  })

  /* ★ 2026-10-06（晚）：这里原来有一条「图落地时高度会长（骨架 → 真图）：
     贴着底就再跟一下，别让新图探出视野」—— 图撤出对话区之后，对话栏的高度
     **不再随图变**，那条装置就没有用武之地了。
     和它配对的那一幕（小图晚一步长出来 → 把"站的那一格"滑进视野）现在归
     时间轴管，钉在 `StepStrip.test.tsx` 里。 */
})
