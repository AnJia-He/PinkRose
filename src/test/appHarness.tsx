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
import { afterEach, beforeEach, expect } from 'vitest'
import type { RouteDecision, SuggestResponse } from '../../shared/protocol.ts'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'
import { MAX_LUT_FILE_BYTES, type LutMeta } from '../../shared/lut.ts'
import type { PresetMeta } from '../../shared/preset.ts'
import type {
  SessionDetail, SessionMessage, SessionMeta, SessionStep,
} from '../../shared/sessions.ts'

// ── 假扮：这些是浏览器能力，jsdom 里没有 ──────────────────────────────
// 原则是"只换掉必要的那一个，其余保留真的"，免得把要测的东西一起假掉。

/** 送到画布上的到底是哪一张 —— 「缩过的那张有没有真的被用上」只能这样看。
 *  用 hoisted：vi.mock 的工厂会被提到所有 import 之前执行。 */
const canvasPropsStore = vi.hoisted(() => ({
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
                  onCompare: (() => void) | undefined
                  // ★ 2026-10-07（点修）：涂抹的现场（笔刷 + 掩码本体 + "涂过了"的回调）。
                  retouch: unknown }[],
}))

/** 画布：真的那个要 WebGL2。这里给一个真 <canvas> 并挂上 ref ——
 *  `send` 的守卫要求 canvasRef.current 非空，假成 null 的话一句都发不出去。 */
vi.mock('../ui/Canvas', async () => {
  const React = await import('react')
  return {
    default: ({ canvasRef, image, params, originalPreview, picking, marker, onPickPoint, busy, viewLocked, crop, comparing, compareWith, resetKey, onCompare, retouch }: any) => {
      canvasPropsStore.images.push(image)
      canvasPropsStore.props.push({
        originalPreview, picking, marker, params, busy, viewLocked, crop,
        comparing, compareWith, resetKey, onCompare, retouch,
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
vi.mock('../render/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/limits')>()
  return { ...actual, probeLimit: vi.fn() }
})

/** 真的缩像素要 2D 画布，jsdom 没有。 */
vi.mock('../image/resize', () => ({ resizeBitmap: vi.fn() }))

/** 导出那一条：`buildExportBlob` 要 canvas.toBlob（jsdom 没实现），
 *  `downloadImage` 要点一个 <a>，都会真动手。**`buildFilename` 保留真的** ——
 *  它是纯函数，而且文件名是要断言的东西。 */
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return {
    ...actual,
    buildExportBlob: vi.fn(),
    downloadImage: vi.fn(),
    shareImage: vi.fn(),
    canShareImage: vi.fn(),
  }
})

/** 送图前的缩放/编码：要 2D 画布，jsdom 没有。 */
vi.mock('../image/prepare', () => ({
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
vi.mock('../core/thumbnail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/thumbnail')>()
  return { ...actual, makeThumbnail: vi.fn(), bitmapToDataUrl: vi.fn() }
})

/** 把圈画进图里那一步要 2D 画布，jsdom 同样给不出来。
 *  **不假掉的话，整条「点了才花钱」的测试永远绿不了** —— 真的 markImage 会在
 *  `getContext('2d')` 那儿抛，`confirmMark` 走进 catch，`postEdit` 一次都不会被调。 */
vi.mock('../image/mark', () => ({ markImage: vi.fn(), MARKER_RADIUS_RATIO: 0.06 }))

/** ★ 2026-10-06（裁剪）：**整个假掉** —— `cropToBitmap` 要真 2D 上下文 +
 *  `createImageBitmap`，jsdom 两样都没有。这一层要验的只是**接线**
 *  （推了步、参数没动、光标挪了、能回去）；像素对不对是 Task 6 真机的事。
 *  假实现返回一张带记号的小位图，"送进去的是哪张、换上来的是哪张"都看得见。 */
vi.mock('../image/crop', () => ({ cropToBitmap: vi.fn() }))

/** ★ 2026-10-07（点修）：同理整个假掉 —— `eraseToBitmap` 要真 2D 上下文 +
 *  `createImageBitmap`，jsdom 两样都没有。这一层验的是**接线**（送进去的是
 *  哪张底图、掩码是不是现场那张、推了步、参数/滤镜没丢、太大要拦）；
 *  像素和耗时是真照片探针的事（`.superpowers/scratch/retouch-probe/`）。 */
vi.mock('../image/erase', () => ({ eraseToBitmap: vi.fn() }))

/** 解码用户选的文件：要 createImageBitmap + 2D 画布。
 *  用 importOriginal 保留它的转发导出（size 那几个），因为别处会 import。 */
vi.mock('../image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/decode')>()
  return { ...actual, decodeImageFile: vi.fn() }
})

/** 「照着这张调」那一步要读像素（源图、参考图各采一遍），要 2D 画布，jsdom 没有。
 *  ⚠️ 假掉的**只有"读像素"这一下**：`samplePixels` 拿到什么内容由各用例自己给，
 *  而 `matchToReference` 本身**真的跑** —— 合流语义正是它和 `setParams` 交界处的
 *  事，假掉拟合就等于把要测的东西一起假掉了。 */
vi.mock('../image/sample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/sample')>()
  return { ...actual, samplePixels: vi.fn() }
})

/** 三个网络出口。**保留真的 ApiError** —— App 里靠 `instanceof ApiError`
 *  决定给用户看哪句话，假掉它就把错误路径一起假掉了。 */
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, postRoute: vi.fn(), postSuggest: vi.fn(), postEdit: vi.fn() }
})

// ── 假扮：滤镜那两条网络 + 缩略图渲染器（要 2D 画布）─────────────────
/**
 * 一个 **2 级恒等 cube** 的原文（`LUT_3D_SIZE 2` 的 8 个格子，红变最快）。
 * 解析出来等于"什么都不改"，所以拿它当"服务端上那个滤镜的文件"最省事。
 *
 * ⚠️ 必须走 `vi.hoisted`：`vi.mock` 的工厂会被提到**所有 import 之前**执行，
 * 而工厂里就要用这个串 —— 直接写一个顶层 `const` 的话，工厂跑的时候它还在
 * TDZ 里（`Cannot access 'cube2TextStore' before initialization`）。
 * 文件里 `canvasPropsStore` 用的是同一个路数。
 */
const cube2TextStore = vi.hoisted(() => [
  'LUT_3D_SIZE 2',
  '0 0 0', '1 0 0', '0 1 0', '1 1 0',
  '0 0 1', '1 0 1', '0 1 1', '1 1 1',
].join('\n'))

/** 缩略图渲染器：jsdom 里 `getContext('2d')` 回 null，真跑会抛。
 *  假成"每张图一个固定的 dataURL"，断言只关心**格子有没有图**。 */
vi.mock('../render/lutPreview', () => ({
  createLutPreview: () => ({
    setImage: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockReturnValue('data:,thumb'),
    dispose: vi.fn(),
  }),
}))

/**
 * ★ 2026-10-08（账本 Task 8）：**离屏管线**（恢复会话时按"底图 + 参数"重画小图）。
 *
 * 真的 `TonePipeline` 要 WebGL2（jsdom 给不出来），假法照 `Canvas.test.tsx` 那份：
 * 记下 `setImage` / `render` 的实参、`dispose` 有没有被叫到。
 * ⚠️ 假 `render` 顺手把参数写进**它那张画布**的 `dataset.rendered` —— 这就是
 * "这张画布现在长这样"（真管线画完像素说的就是这件事），而假 `makeThumbnail`
 * 读的正是它（和假 Canvas 那半边同源）—— 于是"恢复出来的小图带不带参数"
 * 变成一条看得见的断言。
 */
type FakePipe = {
  canvas: HTMLCanvasElement
  images: unknown[]
  renders: [unknown, number][]
  disposed: boolean
}
/** ⚠️ 走 `vi.hoisted`（`vi.mock` 的工厂被提到所有 import 之前跑，同 `canvasPropsStore`）。 */
const pipesStore = vi.hoisted(() => [] as FakePipe[])
vi.mock('../render/pipeline', () => ({
  TonePipeline: class {
    rec: FakePipe
    constructor(canvas: HTMLCanvasElement) {
      this.rec = { canvas, images: [], renders: [], disposed: false }
      pipesStore.push(this.rec)
    }
    setImage(img: unknown) { this.rec.images.push(img) }
    resizeToImage() {}
    render(params: unknown, amount = 0) {
      this.rec.renders.push([params, amount])
      this.rec.canvas.dataset.rendered = JSON.stringify(params)
    }
    dispose() { this.rec.disposed = true }
  },
}))
/** 滤镜那两条网络。**默认**给一条「黄昏」+ 一份能解析的 cube 文本 ——
 *  各用例要"清单里没有它"的样子，自己在用例里盖 `mockResolvedValue`。
 *  ⚠️ 这两条**必须**接住：掉进那个兜底的 blob 形状的话，`listLuts` 每挂一次
 *  App 就往控制台刷一行「滤镜清单没取回来」—— 噪声会盖住真话（和会话列表同一条理由）。 */
vi.mock('../api/luts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/luts')>()
  return {
    ...actual,
    listLuts: vi.fn().mockResolvedValue({ luts: [{ id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }] }),
    lutFileText: vi.fn().mockResolvedValue(cube2TextStore),
    createLut: vi.fn(), renameLut: vi.fn(), deleteLut: vi.fn(), lutUsage: vi.fn(),
  }
})

import App from '../App'
import { PRESETS } from '../core/presets'
import { MIN_SLICE_RATIO, formatSize, modelValue, pie3dPaths } from '../ui/AccountPage'
import type { PublicConfig } from '../api/models'
import { matchToReference, type Rgb } from '../core/colorMatch'
import * as decodeMod from '../image/decode'
import * as prepareMod from '../image/prepare'
import * as api from '../api/client'
import * as limitsMod from '../render/limits'
import * as resizeMod from '../image/resize'
import * as saveMod from '../export/save'
import * as thumbMod from '../core/thumbnail'
import * as markMod from '../image/mark'
import * as cropMod from '../image/crop'
import * as eraseMod from '../image/erase'
import { stampBrush } from '../core/retouch'
import * as sampleMod from '../image/sample'
import * as lutsMod from '../api/luts'
// ★ 2026-10-08（账本 Task 5）：预算闸那一条要**抓住它被叫到** —— 纯逻辑在
// `core/ledger.test.ts` 里单测兜着，这一层钉的是"四处记账有没有接上"。
// ⚠️ 打桩打在**收口**（`settleLedger`）上、不是 `enforceLedgerBudget` 上：
//   2026-10-08 App 拆分时 `settleLedger` 从 `App.tsx` 搬进了 `core/ledger.ts`，
//   从那儿起它是**模块内部**调用 `enforceLedgerBudget` —— 模块内部的调用任何
//   桩都拦不到（`vi.spyOn` 换的是导出对象上那个属性）。钉"接没接上"这一层
//   本来就该盯**记账点和收口之间**那一跳，拦截点跟着收口走。
import * as ledgerMod from '../core/ledger'

// ── 每张"底"带一个记号，好认出送上去的到底是哪一张 ──────────────────
export let bitmapSeq = 0
export function fakeBitmap(tag: string) {
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
export const decodedBitmaps: ImageBitmap[] = []
/** 上传染回来的**包装对象**（`decodeImageFile` 的返回类型），不是裸的 bitmap。 */
export function fakeDecoded(tag: string) {
  return { bitmap: fakeBitmap(tag), width: 1200, height: 800 }
}

export let container: HTMLDivElement
export let root: Root

// ── 登录这件事（Task 7） ─────────────────────────────────────────────
/** 默认"已经登录"的那个人。修图那些测试的前提都是他。 */
export const LOGGED_IN = { id: 1, username: '小明', email: 'a@b.com' }
/** 后端此刻认不认人。null = 没登录（`/api/me` 回 401）。 */
export let meUser: { id: number; username: string; email: string } | null = LOGGED_IN
/**
 * ★ 2026-10-04：`/api/me` 现在还会带 `usage`（作品张数 / 占的空间 / 上限）——
 * 用户管理页的「使用情况」那一格吃的就是它（数据源从"前端拉整份作品清单自己加"
 * 换成了这个，因为那边**把会话占的空间也算进去了**）。
 * `null` = 这一版响应里没有 usage（老后端 / 半坏的响应）。
 */
export let meUsage: { count: number; bytes: number; limit: number } | null = null
/** 数过几次 `/api/me` —— 用户管理页挂载时那一次要能单独认出来（挂住它用）。 */
export let meCalls = 0
/** 把**用户管理页那一次**（第 2 次起的）`/api/me` 挂住不回，演"用量还在路上"。 */
export let meUsageGate: { promise: Promise<void>; open: () => void } | null = null
/** `/api/me` 这一路单独坏掉（登录成了、但紧接着那一次问不出"我是谁"）。 */
export let meFails = false
/** 把 `/api/me` 那一次**挂住不回**，用来演"跟随请求还在半路"那一段。 */
export let meGate: { promise: Promise<void>; open: () => void } | null = null
export let fetchMock: ReturnType<typeof vi.fn>

/** 把一个**还在飞的请求挂住不回**，返回它的 promise 和放行用的 `open`。
 *
 *  "挂住一个请求"这个动作在本文件里出现过好几处（`/api/me` 两条、建议卡片两条），
 *  手搓的写法每处都要重复三行 `let open!` + `new Promise(res => { open = res })`。
 *  `T` 是**那个请求的返回类型**（不给就是 `void`）—— 卡片那两条要的是
 *  `SuggestResponse`，写成 `void` 的话放行时带的数据会被丢掉。
 */
export function makeGate<T = void>() {
  let open!: (v: T) => void
  const promise = new Promise<T>(res => { open = res })
  return { promise, open }
}

// ── 假扮：IntersectionObserver（jsdom 里没有这个浏览器能力）─────────────
// 作品页靠它知道"用户滚到底了"，而"滚动"在 jsdom 里根本演不出来 —— 所以这里
// 给一个**能被测试按下去**的假的：记下谁在观察**哪个节点**，测试想演"滚到底了"
// 就按一下。
/** 现在活着的观察者。`beforeEach` 要清空 —— 上一条用例的组件已经卸载了。 */
export const ioObservers: FakeIntersectionObserver[] = []
/** 演"用户滚到底了"：把那条通知递给所有**真的在看东西**的观察者。
 *  ⚠️ 一个没看任何元素的观察者**不通知** —— `io.observe(el)` 得真的算数：
 *  把它整句删掉，这条测试必须红（"测试看不见它"那一类，这个仓库咬过好几次）。 */
export function scrollToEnd() {
  for (const o of [...ioObservers]) {
    if (o.watching.size > 0) o.cb([{ isIntersecting: true }])
  }
}
export class FakeIntersectionObserver {
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

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } })
}

/** 一条作品的**元数据**（列表和详情这两条路共用这个形状）。
 *  原来是「作品页」那个 describe 里的局部函数，Task 12 挪到了这里 ——
 *  详情页的用例也要造同一种东西，**造两份**的话哪天接口多一个字段，
 *  只会有一份跟着改。第三个参数 `alias` 从 Task 11 起就在（默认 null = 用时间当名字）。 */
export const WORK = (id: number, updatedAt: number, alias: string | null = null) =>
  ({ id, alias, createdAt: updatedAt, updatedAt, bytes: 100, hasThumb: true })

/** 服务端上那条滤镜（`vi.mock('../api/luts')` 的默认清单就是它）。
 *  ★ 2026-10-05（T12）：作品配方里只存滤镜的**名字**，「套到别的图上」凭它找回 id。 */
export const HUANGHUN: LutMeta = { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }

/** 给 fetch 加上"取作品列表"这一条路。**只加不改** —— 别的请求仍然走原来的实现。
 *  （原来住在「作品页」那个 describe 里；Task 8 那一轮修使用情况时，用户管理页
 *   也要拉同一个接口 —— 照上面 WORK 那条注释的道理，两个用例组共用的桩子就一份。） */
export function withWorks(works: unknown[]) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') return jsonResponse({ works })
    return inner(url, init)
  })
}

/** 盖上"取作品列表失败"这一条 —— 500 + 一句服务端的话（用 sentinel 认领它）。 */
export function withWorksError(message: string) {
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
export function withUsage(u: { count: number; bytes: number }) {
  meUsage = { limit: 5 * 1024 ** 3, ...u }
}

/** 用户管理页那一次用量请求失败（500 + 一句服务端的话，用 sentinel 认领它）。 */
export function withUsageError(message: string) {
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
export const MODEL = (id: number, o: Partial<PublicConfig> = {}): PublicConfig => ({
  id, kind: 'chat', provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat',
  alias: '我的便宜货', keyHint: 'sk-…4f2', active: false, ...o,
})

/** 给 fetch 加上"取模型清单"这一条路（`GET /api/models`）。
 *  用户管理页的「模型」那一行要拿它算右边那格写什么，模型设置页整页都要它。 */
export function withModels(configs: PublicConfig[]) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/models' && (init?.method ?? 'GET') === 'GET') return jsonResponse({ configs })
    return inner(url, init)
  })
}

/** 盖上"取模型清单失败"这一条 —— 500 + 一句服务端的话（用 sentinel 认领它）。 */
export function withModelsError(message: string) {
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
export function withSessionsError() {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions' && (init?.method ?? 'GET') === 'POST') {
      return jsonResponse({ error: { code: 'INTERNAL', message: '建不起来' } }, 500)
    }
    return inner(url, init)
  })
}

export function decision(over: Partial<RouteDecision> = {}): RouteDecision {
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
    // ★ 2026-10-10（我的预设）：`preset` 同样是必填 —— 这份默认值就是
    //   "这次不碰预设"的表态（对话那条的正式接线在 Task 5b）。
    preset: null,
    ...over,
  }
}

// ── 「造一条真会话」的三件套 ─────────────────────────────────────────
// ★ 2026-10-05（滤镜 T8）从「恢复」那个 describe 里**整段挪到这儿**的
//   （原文照搬，注释一条没丢）—— 理由和上面 `WORK` 那条一模一样：
//   滤镜那组也要"让 GET /api/sessions 回一条真会话"，**造两份**的话哪天
//   服务端的形状变了，只会有一份跟着改。

/** 一条会话的元数据。`updatedAt` 决定它在列表里排第几（服务端按它倒序给）。 */
export const SMETA = (id: number, over: Partial<SessionMeta> = {}): SessionMeta => ({
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
export function makeSession(
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
export function withSessions(initial: SessionDetail[], opts: { originalFails?: boolean } = {}) {
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

/**
 * ★ 2026-10-10（「我的预设」T3）：盖上一整套 `/api/presets` 的四个动词 ——
 * **有状态的那种**（照上面 `withSessions`：GET 回当前名单，POST/PATCH/DELETE
 * 真改它、之后 GET 看得到）。
 *
 * ⚠️ 为什么走**真网络形状**而不是 `vi.mock('../api/presets')` 那种模块假桩：
 *   这一层要钉的正是"存下来那个**请求体**（`{name, params}`）"和"改完之后
 *   重拉一遍"这两件事 —— `api/presets.ts` 那四个动词就在这条链上，绕开它
 *   等于把要测的东西一起假掉（Task 2 已经在 `src/api/presets.test.ts` 里
 *   单独钉过 URL / 方法 / 字段名，两边合起来才是一条完整的路）。
 */
export function withPresets(initial: PresetMeta[]) {
  let rows = [...initial]
  /** 建出来的新 id：501 起（和造数据那几个 id 段分得开，一眼认得出是"刚存的"）。 */
  let nextId = 501
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/presets' && method === 'GET') return jsonResponse({ presets: rows })
    if (url === '/api/presets' && method === 'POST') {
      const sent = JSON.parse(String(init?.body)) as { name: string; params: Adjustments }
      const preset: PresetMeta = { id: nextId++, ...sent, createdAt: 0 }
      rows = [preset, ...rows]
      return jsonResponse({ preset })
    }
    const one = /^\/api\/presets\/(\d+)$/.exec(url)
    if (one && method === 'PATCH') {
      const sent = JSON.parse(String(init?.body)) as { name: string }
      const id = Number(one[1])
      rows = rows.map(r => (r.id === id ? { ...r, name: sent.name } : r))
      return jsonResponse({ preset: rows.find(r => r.id === id) })
    }
    if (one && method === 'DELETE') {
      rows = rows.filter(r => r.id !== Number(one[1]))
      return jsonResponse({ ok: true })
    }
    return inner(url, init)
  })
  return { rows: () => rows }
}

/**
 * 往**受控输入框**里打字（搜索框那两处：作品页、对话列表）。
 *
 * ⚠️ 直接写 `box.value = '…'` 再派一个 input 事件**不行**：React 18 给受控输入
 * 挂了自己的 value tracker，而 `el.value = x` 走的正是 React 那个 setter ——
 * tracker 跟着一起更新，于是 React 认为"值没变"、onChange 一次都不调。
 * 实测（brief 的字面写法）：搜完之后两个格子全都还在，这条断言红在"2 ≠ 1"。
 * 得用**原型上的 setter** 绕过去值才真的"变"了（登录页那条同理，
 * 见「登录这道门」里的 type()）。
 *
 * ★ 2026-10-07 从「作品页」那个 describe 提到这里：对话列表的页头也加了搜索框，
 * 两边共用这一份（复制第二份的话，这条"直接赋值不行"的账只在一边写着）。
 */
export const boxSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
export async function typeIn(box: HTMLInputElement, text: string) {
  await act(async () => {
    boxSetter.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
  })
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
  canvasPropsStore.images.length = 0
  canvasPropsStore.props.length = 0
  pipesStore.length = 0
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
  // ★ 2026-10-08（终审）：滤镜清单的**默认**也得在这里重立 —— `clearAllMocks()`
  //   只清调用记录、**不恢复实现**，而「删 Lut 时没定稿的那一笔也扫」那条用例
  //   在用例里把基础实现盖成了 `{luts: []}`（once + 基础两段式）。不重立的话，
  //   排在它后面的用例从此拿到一张空清单 —— 今天不依赖所以绿，将来会莫名其妙红。
  vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUANGHUN] })
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
  // ★ 2026-10-07（点修）：「擦掉这里」擦出来的那一张（记号 `erased` 一眼分得开）。
  vi.mocked(eraseMod.eraseToBitmap).mockResolvedValue({
    bitmap: fakeBitmap('erased'), coverage: 1200, usedSource: true,
  })
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
    // ★ 2026-10-10（「我的预设」T3）：App 挂载时 `usePresets` 会问一次清单。
    //   默认**一套都没有**（和作品 / 模型同口径：绝大多数用例从零开始）——
    //   要测"存了 / 满额"的样子，各用例自己用 `withPresets` 盖上一条真的。
    //   ⚠️ **必须接住**：掉进下面那个兜底的 blob 形状的话，`listPresets` 回回
    //   都炸、每条用例的控制台多一行「预设清单没取回来」—— 噪声会盖住真话
    //   （和会话列表那一条同一个理由）。
    if (url === '/api/presets' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ presets: [] })
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
      // 响应是 `SessionMeta`；**`title` 照请求里那个回**（★ 2026-10-09）：
      // 对话栏顶上那颗铅笔改名之后，屏幕上显示的就是服务端回来的这格
      // （真服务端 `handlePutSession` 回的也是更新后的 meta）。原来这里恒回
      // `title: null` —— 那条路读它的话，"改完名顶上没变"会被测试当成对的。
      // 空串 = 清空，服务端存成 `null`（照 `server/sessions.ts` 那道口径）。
      const sent = JSON.parse(String(init?.body ?? '{}')) as { title?: unknown }
      const title = typeof sent.title === 'string' ? (sent.title.trim() || null) : null
      return jsonResponse({
        id: 1, title, originalName: null,
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
    // ★ 2026-10-09：改用户名。回的是**改完之后**那份 user（真服务端
    // `handleChangeUsername` 就是这个形状），而且**顺手把 meUser 也改了** ——
    // 真服务端之后每一趟 `/api/me` 回的也是新名字，假的那份得跟着动。
    // ⚠️ **必须接住**：掉进下面那个兜底的 blob 形状的话，`post()` 会在读正文
    // 那一步炸成 ApiError，界面显示「没改成，过一会儿再试。」—— 而那趟改名
    // **其实成功了**，测试绿在一个"界面撒谎"的路径上。
    // ⚠️ 它和 `/api/password` **不一样**：这一趟**不发新票**（没有 set-cookie），
    //    由 `server/app.test.ts` 的那条钉着。
    if (url === '/api/username' && (init?.method ?? 'GET') === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { username?: unknown }
      meUser = { ...(meUser ?? LOGGED_IN), username: String(sent.username ?? '') }
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

export async function renderApp() {
  await act(async () => { root.render(<App />) })
}

export async function uploadPhoto() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
  })
}

/** 说一句话。输入框是非受控的，所以直接写 DOM 值再提交表单就行。 */
export async function say(text: string) {
  const input = container.querySelector('input[name="text"]') as HTMLInputElement
  const form = container.querySelector('form.chat-input') as HTMLFormElement
  input.value = text
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 0))
  })
}

/** 助手说的最后一句（不含"正在…"那个气泡）。 */
export function lastReply(): string {
  const bubbles = container.querySelectorAll('.bubble.assistant:not(.pending)')
  return bubbles.length ? (bubbles[bubbles.length - 1].textContent ?? '') : ''
}

/** 生成回来的图（`postEdit` 的应答）。三处用例共用一份。 */
export const OK = { imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800 }

/** 按文字点一颗按钮（确认条那两颗走它 —— 不按位置找）。 */
export async function clickByText(text: string) {
  const btn = [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement
  expect(btn, `屏幕上没有「${text}」这颗按钮`).toBeTruthy()
  await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 0)) })
}

/** 点左栏导航。按**文字**找，不按位置 —— 位置是排版的事，文字才是用户的认知。 */
export async function goNav(name: string) {
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
export async function openChatTool(name: string): Promise<HTMLElement> {
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
export async function waitPersist() {
  await act(async () => { await new Promise(r => setTimeout(r, 900)) })
}

/** 某一笔请求的请求体（已经 JSON.parse 过）。 */
export function bodyOf(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body))
}

// ── 滤镜（★ 2026-10-05 T8 建，T9 / T11 / T12 共用）────────────────────
// 四个都按**文字**或**类名**找，不按位置 —— 位置是排版的事，文字才是用户的认知。

/** 微调区那一栏（`App.tsx` 里 `view.kind === 'adjust'` 才挂）。 */
export const adjustPanel = () => container.querySelector('.panel') as HTMLElement
/** 打开微调区那一栏「滤镜」。**它默认是收着的**（spec §8.3），所以每一条都要先点一下。 */
export async function openLutPanel() {
  const head = [...adjustPanel().querySelectorAll('.panel-group-head')]
    .find(b => (b.textContent ?? '').includes('Lut')) as HTMLButtonElement
  await act(async () => { head.click(); await new Promise(r => setTimeout(r, 0)) })
}
export const lutTiles = () => [...adjustPanel().querySelectorAll('.lut-tile')] as HTMLButtonElement[]
export const tileNamed = (name: string) => lutTiles().find(t => (t.textContent ?? '').includes(name))!
/** 面板里「滤镜」那一组（`section`）—— 强度滑块要**在这一组里面**找，别数全屏的滑块。 */
export const lutSection = () => [...adjustPanel().querySelectorAll('.panel-group')]
  .find(g => g.querySelector('.panel-group-title')?.textContent === 'Lut') as HTMLElement

// ── 测试 ─────────────────────────────────────────────────────────

// ── 给"拆出去的那几个测试文件"用的补丁（2026-10-09）────────────────────

/**
 * 测试中途会拧的那几个开关 —— **导出的是 setter，不是变量**。
 *
 * ⚠️ ESM 的 import 绑定在**导入方是只读的**：那几个 `let` 直接导出的话，
 *   测试里写 `meUser = null` 当场是语法错误。写入走 setter，
 *   读取照旧直接读（导出的 `let` 是活绑定，beforeEach 里改了那边看得见）。
 */
export const setMeUser = (v: typeof meUser) => { meUser = v }
export const setMeUsage = (v: typeof meUsage) => { meUsage = v }
export const setMeCalls = (v: typeof meCalls) => { meCalls = v }
export const setMeFails = (v: typeof meFails) => { meFails = v }
export const setMeGate = (v: typeof meGate) => { meGate = v }
export const setMeUsageGate = (v: typeof meUsageGate) => { meUsageGate = v }

/**
 * 「重开一次页面」—— 换 root 重挂。
 *
 * ⚠️ 必须**换一个 root**：`root.render()` 第二次不重跑 `useState` 的初始化器，
 *   同一个实例还留着老 view 和那张照片。原来三段测试各自抄了这六行
 *   （注释里那句"本文件里'重开一次页面'的惯用写法"说的就是它）。
 */
export async function reopenApp(): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await renderApp()
}

// 下面两批是"脚手架从别处 import 进来、测试体还要用"的名字 —— 原样转出去，
// 拆出去的文件只认这一个 import（顺带把"mock 先注册、模块后加载"那条顺序
// 关在这个文件里，外面不用操心）。
export { MAX_LUT_FILE_BYTES, MIN_SLICE_RATIO, PRESETS, ZERO, act, createRoot, formatSize, matchToReference, modelValue, pie3dPaths, stampBrush }
export { decodeMod, prepareMod, api, limitsMod, resizeMod, saveMod, thumbMod, markMod, cropMod, eraseMod, sampleMod, lutsMod, ledgerMod }
export type { Adjustments, LutMeta, Rgb, RouteDecision, SessionDetail, SessionStep, SuggestResponse }

// ⚠️ 上面那三个 `vi.hoisted` 的值**不能直接 export**（esbuild 会报
//   "Cannot export hoisted variable"：它得把初始化提到 import 之前，而 export
//   的声明不能被提走）—— 所以它们在文件里叫 `*Store`，这里用普通 const 转出去。
//   转出去的是**同一个对象**：测试只改它里面的内容（push / 清空），从不重新赋值。
export const canvasProps = canvasPropsStore
export const CUBE2_TEXT = cube2TextStore
export const pipes = pipesStore

// ── 测试体反复要用的几个动作 ────────────────────────────────────────────
// ★ 2026-10-09：拆成六个文件之后，这几个原来在各 describe 里各有一份的小助手
//   变成了"跨文件各一份"。收进这里一份（都在同一份文件里，不再到处找）。

/** 几条打到某条会话上的更新请求（`steps` 是唯一看得见历史的地方）。 */
export   const putCalls = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === 'PUT')

/** 屏幕上所有气泡的文字（用户的和助手的都在里面）。 */
export   const bubbleTexts = () =>
    [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')

/** 一步一格 —— **转盘上的格子**（顺序 = 步骤顺序，站着那格是 `<span>`）。 */
export   const stepItems = () =>
    [...container.querySelectorAll<HTMLElement>('.strip-node')]

/** 拨一条调色滑块：点数字 → 打字 → 回车。 */
export   async function setSlider(name: string, value: number) {
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

/** 进裁剪 → 立刻「完成」= **换了一次底图**（账本上加一笔、落盘那趟 `baseChanged`）。 */
export   async function cropOnce() {
    const cell = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    expect(cell, '工具行里该有「裁剪」').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('完成')
  }
