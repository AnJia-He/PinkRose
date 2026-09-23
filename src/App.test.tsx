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
import type { RouteDecision } from '../shared/protocol.ts'
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
        onClick: () => onPickPoint && onPickPoint(0.5, 0.5),
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
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x']) })))

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

  /** 在图上点一下 —— 假的 Canvas 把这一下报成画面正中间那个点。 */
  async function tapPhoto() {
    await act(async () => {
      (container.querySelector('canvas') as HTMLCanvasElement).click()
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

  it('点错了还能换个地方再点 —— 确认之前标记一直可以改', async () => {
    await askOnPhoto()
    await tapPhoto()
    // 点完不该把点选模式关死：用户想换个地方，直接再点一下就行
    await act(async () => { (container.querySelector('canvas') as HTMLCanvasElement).click() })
    expect(canvasProps.props.at(-1)?.marker).toEqual({ x: 0.5, y: 0.5 })
    expect(api.postEdit).not.toHaveBeenCalled()
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
