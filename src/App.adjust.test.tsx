// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **滤镜与调色账本那一簇**。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import {
  CUBE2_TEXT,
  HUANGHUN,
  OK,
  WORK,
  adjustPanel,
  bodyOf,
  bubbleTexts,
  canvasProps,
  clickByText,
  container,
  cropOnce,
  decision,
  decodedBitmaps,
  fakeDecoded,
  fetchMock,
  goNav,
  jsonResponse,
  lastReply,
  lutSection,
  makeGate,
  makeSession,
  openChatTool,
  openLutPanel,
  pipes,
  renderApp,
  say,
  setSlider,
  stepItems,
  tileNamed,
  uploadPhoto,
  waitPersist,
  withSessions,
  withWorks,
} from './test/appHarness'
import { act } from 'react'
import { ZERO } from '../shared/adjustments.ts'
import { type LutMeta } from '../shared/lut.ts'
import { matchToReference, type Rgb } from './core/colorMatch'
import * as decodeMod from './image/decode'
import * as api from './api/client'
import * as thumbMod from './core/thumbnail'
import * as eraseMod from './image/erase'
import { stampBrush } from './core/retouch'
import * as sampleMod from './image/sample'
import * as lutsMod from './api/luts'
import * as ledgerMod from './core/ledger'
import { describe, expect, it, vi } from 'vitest'
import type { RouteDecision } from './test/appHarness'

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

  /**
   * ★ 2026-10-08（用户原话：「套上滤镜后在对话区回溯到第一版再回到刚才的，
   *   滤镜没套上 —— 这是对的吗？就是这样设计的吗？」）：**不是设计，是丢了**。
   *
   * 一步的快照记的是**它出生那一刻**的 params / lut（拖滑块、套滤镜不推快照，
   * 裁定 ⑤），而 `onJump` 还原照的是快照 —— 不把现场改动写回最新那一步，
   * "跳走再跳回来"就把它丢掉（而**刷新一下它却在**：落盘那条路把"现在这一版"
   * 挂在最后一步上）。App 里那条写回 effect 就是补这个洞，下面两条各守一半。
   *
   * ⚠️ 跳转手法有个坑（这两条测试第一版就踩了，记下来）：转盘上**站着那格是
   *    `<span>`（点不动）**，跳一次之后原来那两格的 button/span 会**互换** ——
   *    拿第一次查到的旧引用点第二下等于没点（测试"红"得毫无道理）。每跳一次
   *    都**重新查**一遍 `.strip-node`。
   */
  it('★ 在最新一步套上的滤镜，跳走再跳回来还在（现场改动写回那一步）', async () => {
    // 变异：把 App 里那条写回 effect 拿掉 → 最后那句红（基线跑过：false）。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUT] })
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好，改好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await goNav('调色')
    await openLutPanel()
    await click(tileNamed('黄昏'))
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    const nodeAt = (i: number) => [...container.querySelectorAll<HTMLElement>('.strip-node')][i]!
    const lastNode = () => nodeAt(container.querySelectorAll('.strip-node').length - 1)

    // 跳回第一版：原图本来就没有滤镜（那一步永远是 lut: null）
    await goNav('修图')
    await click(nodeAt(0))
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')

    // 再跳回来 —— 刚才套上的那层颜色**得在**（用户报的那一下）
    await goNav('修图')
    await click(lastNode())
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
  })

  it('★ 在最新一步调好的参数，跳走再跳回来也在（和滤镜同一条写回）', async () => {
    // 和上一条**同一个洞的另一半**：拖滑块 / 说「亮一点」也不推快照，
    // 跳回来的还原同样照快照 —— 写回 effect 一次管两样（params 和 lut 是并列的
    // 两件事，走同一条路）。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '好，改好了。' }))
      .mockResolvedValueOnce(decision({ route: 'params', paramDeltas: { exposure: 25 }, reply: '亮了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('亮一点')

    // 画布上真渲染出来的参数（不是内部 state）—— 锚在用户看得见的东西上
    const rendered = () =>
      JSON.parse((container.querySelector('canvas') as HTMLCanvasElement).dataset.rendered!)
    expect(rendered().exposure).toBe(25)

    const nodeAt = (i: number) => [...container.querySelectorAll<HTMLElement>('.strip-node')][i]!

    await click(nodeAt(0))                                     // 回原图：参数本来就该是 0
    expect(rendered().exposure).toBe(0)

    await click(nodeAt(container.querySelectorAll('.strip-node').length - 1))   // 再跳回来
    expect(rendered().exposure).toBe(25)                       // ← 丢参数那一半
  })

  it('★「回到这一步」跟着那一步把滤镜也还原（和参数对称）', async () => {
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
    //   ★ 2026-10-08（账本 Task 7）：读的是**快照那一份**（`steps[].lut`）——
    //   今天顶层那个 `lut` 只在"这一版脏了"时才送（没人改就一个字节都不动，
    //   见 `dirtyRef`），所以"没被清掉"这件事要看历史那一半才咬得住。
    await waitPersist()
    expect((lastPutBody().steps.at(-1) as { lut?: unknown }).lut)
      .toEqual({ lutId: 1, amount: 80 })
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

describe('「回到这一步」不再删后面的步骤', () => {

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
    // 变异：去掉 `send` 里那道闸 → ①③ 当场红（屏幕上没有"画面已经变了"那句通报、
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

    // ① 通报一句（说清哪一趟、还能怎么办）—— ★ 2026-10-06 终审 I2 改了措辞：
    //    裁剪也会推 baseSeq 触发同一道闸，而用户根本没切走，所以那句
    //    「你切走时…」是假话。现在说的是两边都成立的那件事：画面已经变了。
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('画面已经变了')
    // ② 没有确认条 —— 尤其不许出现"后面还有 0 步"那种自相矛盾的胡话
    expect(container.textContent).not.toContain('后面还有')
    // ③ 钱没花：这一趟在闸门处就作废了
    expect(api.postEdit).not.toHaveBeenCalled()
    // ④ 新会话（B）的气泡里没有 A 那句话 —— 串会话一个字节都没发生
    expect(bubbleTexts()).not.toContain('换个方向')
  })

  it('★（终审残留）上传后立刻说话、建会话这时才回来 → 照常生成（不许拿"画面已经变了"的假话打发）', async () => {
    // 它和上面那道闸的**另一半**：`onPick` 里建会话是不 await 的（"锦上添花"，
    // `busy` 在它回来之前就清了），所以用户完全可能在建会话回来之前先说了一句。
    // 这趟出发时 `sidAt === null`，建会话回来把 `sessionIdRef` 从 null 拨成 id ——
    // 那是**同一条会话在长出来**，不是"画面变了"。闸门要是连这一格也比，用户会拿到
    // 一句**假话**（屏幕上根本没换东西），而且刚说的那句话被扔掉（"这边没动它"）。
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

    expect(container.querySelector('.notice')?.textContent ?? '').not.toContain('画面已经变了')
    expect(api.postEdit).toHaveBeenCalledTimes(1)      // 这句话照常生效
  })
})

describe('调色的「一笔」：停手 0.8 秒定稿', () => {
  const stepNav = () => container.querySelector('.step-nav')
  const navBtns = () => [...container.querySelectorAll<HTMLButtonElement>('.step-nav-btn')]
  /** 点一下 + 让 React 把状态刷完（这个文件里别处同款）。 */
  const tap = (el: HTMLElement) =>
    act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })



  it('★ 连着调（不歇）= 同一笔；停手 0.8 秒才定稿', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    await setSlider('亮度', 40)
    await setSlider('亮度', 60)                  // 两次改、中间没歇
    // 还没停手：账本只有出生那一笔 —— 那组箭头**整组不画**（total ≤ 1，spec §5.3）
    expect(stepNav()).toBeNull()

    await waitPersist()                          // 停手 → 定稿
    // 两次改**合并成一笔**：账本 = 出生 + 1 笔（要是不合并，这里会是 3 / 3）
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(60)
  })

  it('★ 定稿后马上退 = 退掉刚才那一笔（先定稿、再退）', async () => {
    // ⚠️ 先裁一刀：**只有一笔（刚上传）时箭头整组不画**（spec §5.3），
    //   所以"调完马上按箭头"这件事只有在账本已经不止一笔时才真发生 ——
    //   也正是这一段：裁完（2 / 2）再调、不等定稿就按。
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()
    expect(stepNav()!.textContent).toContain('2 / 2')

    await setSlider('亮度', 60)                  // 这一笔**故意不定稿**
    await tap(navBtns()[0]!)                     // 不到 800ms 就按

    // 退的是**刚才调的那下**：参数回 0，而底图还是裁完那张（那一刀没被退掉）
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(0)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'cropped' } })
    // 而且那一笔**被记上了**：账本 = 出生 + 裁剪 + 调色，人此刻站在中间那一笔
    expect(stepNav()!.textContent).toContain('2 / 3')
  })

  it('净零（拖走又拖回原值）不记 —— 账本上不留空笔', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()
    expect(stepNav()!.textContent).toContain('2 / 2')

    await setSlider('亮度', 60)                  // 拖走
    await setSlider('亮度', 0)                   // 又拖回原值
    await waitPersist()                          // 停手 → 该定稿了
    // 净变化为零：**不记**（不是"记了一笔又退掉"，是压根没有第三笔）
    expect(stepNav()!.textContent).toContain('2 / 2')
  })

  it('★ 剪一刀之前，先把没定稿的调色单独记一笔（顺序：先调色、后裁剪）', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const beforeCrop = canvasProps.images.at(-1)

    await setSlider('亮度', 40)                  // 不等定稿
    await cropOnce()                             // 立刻落刀

    // 三笔，顺序是**先调色、后裁剪**（反了的话退一步会一次退掉两件事）
    expect(stepNav()!.textContent).toContain('3 / 3')
    // 退一步 = "没裁、但调过色" —— 两半各归各位
    await tap(navBtns()[0]!)
    expect(stepNav()!.textContent).toContain('2 / 3')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(40)   // 调色还在
    expect(canvasProps.images.at(-1)).toBe(beforeCrop)           // 那一刀退了
  })

  it('★ 调一下 → 说句话去改 → 又调一下：新版本上那一下也记得上（生成的定稿点）', async () => {
    // 定稿点里最不显眼的一处（spec §5.5「生成落地」）：生成成功要**推一个新版本**，
    // 而"没定稿的那一笔调色"属于**出发那一版** —— 不在推新版本之前把它定下来，
    // 那个待办会一直挂着（待办**同时只许有一个**）：新版本上的第一下调整会被它
    // 挡住，**一笔都记不上**（而屏幕上颜色照变、一句错都不报）。
    // 变异：把 `useGeneration` 成功路径里那句 `flushEdit()` 删掉 → 最后那句
    // `2 / 2` 当场红（新版本只有出生那一笔，那组箭头干脆整组不画）。
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await setSlider('亮度', 50)                  // ① 旧版本上的那一笔，不定稿
    // ⚠️ 说话得回修图屏：调色那一屏**没有对话栏**（用户点名的"那两个区"）
    await goNav('修图')
    await say('按这个亮度再改一下')               // ② 生成落地（新版本出生）
    await goNav('调色')
    await setSlider('亮度', 30)                  // ③ 新版本上的第一下调整

    await waitPersist()                          // 停手 → 该定稿了
    // 新版本的账本 = 出生 + 刚才那一下（旧版本那一笔**不许**跑到这儿来）
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(30)

    // 而旧版本上那一笔也各归各位：回原图那一版看，它是 2 / 2、画面是 +50
    await goNav('修图')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes()).toHaveLength(2)
    await act(async () => { nodes()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await goNav('调色')
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(50)
  })

  it('★ 调一下 → 点转盘跳到另一版 → 在那儿再调一下：两版各记各的（跳转的定稿点）', async () => {
    // 和上一条**同一个形状**的另一处定稿点（spec §5.5「点转盘跳版本」）：
    // 待办同时只许有一个 —— 跳走时不定稿的话，那一笔会一直挂在**旧版本**头上，
    // 挡住新站的那一版"起一笔"（它的改动照旧镜像进快照，却**一笔都记不上**）。
    // 变异：把 `onJump` 头一句 `flushEdit()` 删掉 → 最后那句 `2 / 2` 当场红
    // （第二版只有出生那一笔）。
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('先改一次')                        // 转盘两格（原图 + 这一版）
    await goNav('调色')
    await setSlider('亮度', 50)                  // ① 第二版上的那一笔，不定稿

    // ② 点转盘跳回第一版（走 `onJump`）
    await goNav('修图')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    await act(async () => { nodes()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })

    await goNav('调色')
    await setSlider('亮度', 30)                  // ③ 第一版上的第一下调整
    await waitPersist()
    expect(stepNav()!.textContent).toContain('2 / 2')            // 出生 + ③
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(30)

    // 而第二版上那一笔也**没被丢掉**：跳回去看，它是 2 / 2、画面是 +50
    await goNav('修图')
    await act(async () => { nodes()[1]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await goNav('调色')
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(50)
  })
})

describe('调色屏的「上一步 / 下一步」= 翻当前这一版的账本', () => {
  const stepNav = () => container.querySelector('.step-nav')
  const navBtns = () => [...container.querySelectorAll<HTMLButtonElement>('.step-nav-btn')]
  /** 点一下 + 让 React 把状态刷完（这个文件里别处同款）。 */
  const tap = (el: HTMLElement) =>
    act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })



  it('只在这一屏出现：修图屏没有它（那一屏的照片上方是转盘）', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()
    expect(stepNav()).toBeTruthy()          // 调色屏：账本有两笔
    await goNav('修图')
    expect(stepNav()).toBeNull()            // 修图屏：这块地方是转盘
  })

  it('★ 裁一刀 → 2 / 2；上一步回到裁之前、下一步回裁之后（画面真的换）', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    expect(stepNav()).toBeNull()            // 刚上传：账本只有一笔，整组不画
    const beforeCrop = canvasProps.images.at(-1)

    await cropOnce()
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(navBtns()[0]!.disabled).toBe(false)     // 后面还有一笔可以退
    expect(navBtns()[1]!.disabled).toBe(true)      // 已经在最新的那一笔
    const afterCrop = canvasProps.images.at(-1)
    expect(afterCrop).toMatchObject({ bitmap: { __tag: 'cropped' } })

    await tap(navBtns()[0]!)                       // 上一步 = 退掉这一刀
    expect(stepNav()!.textContent).toContain('1 / 2')
    // 画面真的换回来了：宽高对调那张、**同一个位图对象**（不是"看着差不多"）
    expect(canvasProps.images.at(-1)).toBe(beforeCrop)
    expect(navBtns()[0]!.disabled).toBe(true)      // 出生那一笔：到头
    expect(navBtns()[1]!.disabled).toBe(false)

    await tap(navBtns()[1]!)                       // 下一步 = 再走回来
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.images.at(-1)).toBe(afterCrop)
  })

  it('★ 两头都不空转：出生那一笔按不动「上一步」、最新那一笔按不动「下一步」', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()
    await setSlider('亮度', 30)
    await waitPersist()                            // 定稿 → 账本三笔
    expect(stepNav()!.textContent).toContain('3 / 3')
    expect(navBtns()[1]!.disabled).toBe(true)      // 最新那一笔：按不动

    await tap(navBtns()[0]!)
    expect(stepNav()!.textContent).toContain('2 / 3')
    await tap(navBtns()[0]!)
    expect(stepNav()!.textContent).toContain('1 / 3')
    expect(navBtns()[0]!.disabled).toBe(true)      // 出生那一笔：按不动
    expect(navBtns()[1]!.disabled).toBe(false)     // 反方向还有得走

    // 真按下去也不动（"两头禁用"不只是画个灰样子）
    await tap(navBtns()[0]!)
    expect(stepNav()!.textContent).toContain('1 / 3')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(0)   // 还是出生那一笔的样子
  })

  it('★ 翻账本不跟对话打交道：一条消息不多、转盘一格不多、一分钱不花', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()

    // 先量一份"翻之前"的样子（对话栏只在修图屏渲染，所以量完再回调色屏）
    await goNav('修图')
    const msgsBefore = bubbleTexts()
    const nodesBefore = container.querySelectorAll('.strip-node').length

    await goNav('调色')
    vi.mocked(api.postEdit).mockClear()
    await tap(navBtns()[0]!)                       // 翻一笔
    await tap(navBtns()[1]!)                       // 再翻回来
    expect(api.postEdit).not.toHaveBeenCalled()    // 一分钱没花

    await goNav('修图')
    expect(bubbleTexts()).toEqual(msgsBefore)                            // 一条消息不多
    expect(container.querySelectorAll('.strip-node')).toHaveLength(nodesBefore)  // 转盘一格不多
    expect(nodesBefore).toBe(1)                    // 而且它本来就只有原图那一格
  })

  it('正在裁剪 / 点修时收起来 —— 不然"翻一笔"会把框和涂抹留在原地', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await cropOnce()
    const cell = () => container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement

    await tap(cell())                              // 打开「裁剪」
    expect(stepNav()).toBeNull()
    await tap(cell())                              // 再点一下 = 收起（判据 unchanged）
    expect(stepNav()).toBeTruthy()
  })

  it('★ 退到中间再动手：后面的笔作废（新的一笔清掉 future）', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    await cropOnce()
    await tap(navBtns()[0]!)                       // 退到"没裁"那一笔
    expect(stepNav()!.textContent).toContain('1 / 2')
    expect(navBtns()[1]!.disabled).toBe(false)     // 后面还留着一笔可以往前走

    await setSlider('亮度', 40)                    // 站在中间继续动手
    await waitPersist()                            // 定稿 → 这一笔把后面清掉
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(navBtns()[1]!.disabled).toBe(true)      // 后面那一笔没有了（标准撤销语义）
    // 画面 = 调过色、**没裁**的那张 —— 那一刀真的作废了
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(40)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })

  it('★ 退到中间、又调了一下、立刻点「下一步」—— 那一笔不丢，按钮也不空转', async () => {
    // ★ 2026-10-08 评审 Important 钉的就是这一下（brief 里那行 `if (target === base) return`
    //   写错了）：账本在**中间**（future 非空、「下一步」可点）时拖一下滑块 ——
    //   内联定稿那一下 `pushEdit` 会**清空 future**，于是紧接着的 `redoEdit` 返回
    //   **同一引用**（真的到头了），那行早返回就把**刚定稿的那一笔**连 `setHistory`
    //   一起丢掉了。两处后果都是"错了不报错"：
    //     ① 刚调的那笔不在账本里（画面照变 —— 之后再按「上一步」会一次退两件事）；
    //     ② 那颗「下一步」看着能点、点了什么都不发生。
    //   变异：把 `ledgerStep` 里那句改回 `if (target === base) return` → 下面
    //   「2 / 2」和最后那两句一起红。
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    await cropOnce()
    await tap(navBtns()[0]!)                       // 退到"没裁"那一笔（future 非空）
    expect(stepNav()!.textContent).toContain('1 / 2')
    expect(navBtns()[1]!.disabled).toBe(false)     // 「下一步」可点

    await setSlider('亮度', 40)                    // 起一笔，**不定稿**
    await tap(navBtns()[1]!)                       // ★ 立刻点「下一步」

    // ① 那一笔**记上了**：这一刻它就是最新的一笔（定稿后 future 本来也空了）
    expect(stepNav()!.textContent).toContain('2 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(40)
    // ② 按钮不空转：真的到头了
    expect(navBtns()[1]!.disabled).toBe(true)

    // ③ 而且它记的**正是刚调的那一笔**：再退一步，退的是"调色"，不是"调色 + 别的"
    await tap(navBtns()[0]!)
    expect(stepNav()!.textContent).toContain('1 / 2')
    expect(canvasProps.props.at(-1)!.params.exposure).toBe(0)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })
})

describe('★ 账本预算闸：记账统一收口（Task 5）', () => {
  const last = () => canvasProps.props.at(-1)!
  const stepNav = () => container.querySelector('.step-nav')
  const navBtns = () => [...container.querySelectorAll<HTMLButtonElement>('.step-nav-btn')]
  const tap = (el: HTMLElement) =>
    act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })

  /** 过闸那一刻它看到的账本 = 收口 `settleLedger` 最后一次的**第二个**入参
   *  （`withEdit`：已经记完那一笔的那份；第一个是记账之前的 `prev`）。 */
  const gated = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.at(-1)![1] as unknown as
    { past: { seq: number }[]; future: { seq: number }[]; params: Record<string, number> }[]



  /** 进点修、涂一笔，返回「擦掉这里」那颗按钮（和「点修」那一组同款：真掩码 + 真回调）。 */
  async function retouchPainted() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="点修"]') as HTMLButtonElement
    await tap(cell)
    const scene = last().retouch as { mask: Uint8Array; onMaskChange: () => void }
    await act(async () => {
      stampBrush(scene.mask, 1200, 800, 600, 400, 40, 'paint')
      scene.onMaskChange()
      await new Promise(r => setTimeout(r, 0))
    })
    return [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '擦掉这里') as HTMLButtonElement
  }

  /** 这一趟落盘那笔 PUT 的请求体（和「滤镜」那一组同款）。 */
  const lastPutBody = () => {
    const puts = fetchMock.mock.calls.filter(([u, init]) =>
      String(u).includes('/api/sessions/') && (init as RequestInit | undefined)?.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
    return bodyOf(puts[puts.length - 1]!)
  }

  it('★ 裁剪那一处：记完这一刀再过闸（顺手件①：记上了就不许刷那句假报错）', async () => {
    const spy = vi.spyOn(ledgerMod, 'settleLedger')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await renderApp()
      await uploadPhoto()
      await goNav('调色')

      await cropOnce()

      expect(spy, '裁剪记完那一笔之后必须过一遍预算闸').toHaveBeenCalled()
      expect(gated(spy)[0]!.past, '过闸时看到的是**记完**的账本（出生 + 裁之前那一笔）')
        .toHaveLength(1)

      // 顺手件①：这一刀明明记上了 —— 「那一版不在了」是**异常**才该说的话，
      // 正常路径上刷出来就是一句没人信的假警报（以后真出问题时谁也不看它）。
      const said = errSpy.mock.calls.flat().map(String).join(' ')
      expect(said, '正常裁一刀不许说"账本没记上"').not.toContain('账本没记上')
    } finally {
      spy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('★ 调色定稿那一处：真的记完才过闸；**净零那一下一个字节都不碰**', async () => {
    // ★ 后半句是 Task 4 特意做出来的行为（净零 / 那一版找不到时**返回原来的引用**）
    //   —— 有一条既有用例靠它（多返回一份新数组会让落盘 effect 白跑、多发一趟 PUT）。
    //   所以过闸必须落在"确实记了一笔"之后：**没有新笔就别碰**。
    //   变异：把 `settleLedger` 那句提到两个早返回**前面** → 前半句红。
    const spy = vi.spyOn(ledgerMod, 'settleLedger')
    try {
      await renderApp()
      await uploadPhoto()
      await goNav('调色')
      await cropOnce()
      spy.mockClear()

      await setSlider('亮度', 60)      // 拖走
      await setSlider('亮度', 0)       // 又拖回原值 → 净零
      await waitPersist()              // 停手 → 该定稿了
      expect(spy, '净零不记一笔 → 不该惊动预算闸').not.toHaveBeenCalled()

      await setSlider('亮度', 40)      // 真的改一下
      await waitPersist()
      expect(spy, '真的记了一笔 → 过闸').toHaveBeenCalled()
      const seen = gated(spy)
      expect(seen[0]!.past, '出生 + 裁剪 + 刚才那一笔').toHaveLength(2)
      expect(seen[0]!.params.exposure, '过闸时当前位置已经是"改之后"').toBe(40)
    } finally {
      spy.mockRestore()
    }
  })

  it('★ 点修那一处 + 翻箭头那一拍的内联定稿：也不许搞特例', async () => {
    const spy = vi.spyOn(ledgerMod, 'settleLedger')
    try {
      await renderApp()
      await uploadPhoto()

      // ① 点修：涂 → 擦（记账就发生在「擦掉这里」那一下）
      const eraseBtn = await retouchPainted()
      spy.mockClear()
      await act(async () => { eraseBtn.click(); await new Promise(r => setTimeout(r, 0)) })
      expect(vi.mocked(eraseMod.eraseToBitmap), '前提：这一擦真的跑了').toHaveBeenCalled()
      expect(spy, '点修记完那一笔之后必须过闸').toHaveBeenCalled()
      expect(gated(spy)[0]!.past, '出生 + 擦之前那一笔').toHaveLength(1)

      // ② 翻箭头那一拍：账本在中间时拖一下滑块、**不等定稿**就按「上一步」——
      //    `ledgerStep` 里的内联 `pushEdit` 也要过闸（那一笔多半没新位图，
      //    但账本形状一样，别搞特例）。
      spy.mockClear()
      await setSlider('亮度', 40)      // 起一笔，不定稿
      await tap(navBtns()[0]!)         // 先内联定稿、再退
      expect(spy, 'ledgerStep 里那一笔也要过闸').toHaveBeenCalled()
      const seen = gated(spy)
      expect(seen[0]!.past.length + seen[0]!.future.length, '两笔都在账本里（退掉的那笔进了 future）')
        .toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('★ seq 按发生次序发（调色那笔 < 裁剪那笔）—— 驱逐挑"最老的一笔"靠它', async () => {
    // ★ 2026-10-08（Task 5 那颗"尽力项"）：预算驱逐按 `seq` 挑**最老的一笔**丢
    //   （spec §6），所以号必须是"先发生的那一笔先领" —— 领反了就等于"内存吃紧
    //   时丢新的、留着老的"（用户最近做的那些全没了、最早那些留着）。
    //   变异（**验证过**）：把 `commitCrop` 里那句发号挪到 `flushEdit()` **前面**
    //   → 先发生的"调色"反而拿到更大的号，下面 `toBeLessThan` 当场红
    //   （实测报 `expected 2 to be less than 1`）。
    // ⚠️ 也写清楚**它测不出什么**：把 `flushEdit` 的号挪进 updater 那种写法在这条
    //   路上测不出来 —— React 对"队列为空"的那一次 `setHistory` 会**当场**调一遍
    //   updater（eager 求值），号还是按调用次序领的。这条钉的是"端到端的先后"，
    //   不是"号写在哪一行"（那件事由 `flushEdit` 顶上那段注释管）。
    const spy = vi.spyOn(ledgerMod, 'settleLedger')
    try {
      await renderApp()
      await uploadPhoto()
      await goNav('调色')

      await setSlider('亮度', 40)      // ① 调色（这一笔**不定稿**）
      await cropOnce()                 // ② 裁剪（它的定稿点：先调色、后裁剪）

      const past = gated(spy)[0]!.past
      expect(past, '两笔：调色、裁剪').toHaveLength(2)
      expect(past[0]!.seq, '先发生的那一笔号更小').toBeLessThan(past[1]!.seq)
    } finally {
      spy.mockRestore()
    }
  })

  it('顺手件②：删 Lut 时**没定稿的那一笔**也扫 —— 退回去不许套回死滤镜', async () => {
    // 场景：手上这张正用着「黄昏」（落在接回来的最后一步上），他调了一下（还没定稿，
    // 那一笔的"改之前"里攥着这个 id），然后跑到 `/app/luts` 把它删了再回来。
    // 不扫待办的话：定稿时把那个**已经不存在的 id** 压进 `past` —— 按一下「上一步」
    // 就把死滤镜又套回画面上（cube 取不到，那层颜色说没就没，一句错都不报）。
    // 变异：去掉 `dropGoneLut` 里扫待办那两行 → 最后那句 `body.lut` 红。
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])
    vi.mocked(lutsMod.listLuts)
      .mockResolvedValueOnce({ luts: [HUANGHUN] })  // App 挂载那一次：还在
      .mockResolvedValue({ luts: [] })             // 离开设置页那一次：已经删了

    await renderApp()
    await goNav('调色')
    await setSlider('亮度', 40)                    // 起一笔，**不定稿**
    await act(async () => {                        // 走到那一页上（同「滤镜」那组的 `gotoPath`）
      window.history.pushState(null, '', '/app/luts')
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    await goNav('调色')                            // 离开那一页 → 照镜子（`dropGoneLut`）
    await waitPersist()                            // 停手 → 定稿
    expect(stepNav(), '记上了那一笔才画得出这组箭头').toBeTruthy()
    expect(stepNav()!.textContent, '账本 = 出生 + 刚调的那一笔').toContain('2 / 2')

    await tap(navBtns()[0]!)                       // 上一步 = 退掉刚调的那一笔
    expect(last().params.exposure, '参数退回了"改之前"（拖滑块之前是 2）').toBe(2)
    await waitPersist()                            // 落盘
    expect(lastPutBody().lut, '退回去不许把死滤镜带回来').toBeNull()
  })

  it('顺手件③：待办挂在被删的那一版上时，删它就把待办一起清', async () => {
    // 定稿闹钟还挂着（拖了滑块、没到 0.8 秒）时把那一版删掉：待办还攥着**旧**
    // stepId，而"起一笔"的判据是**待办为空**（同时只许有一个）—— 不清的话，
    // 站在新那一版上怎么调都记不上一笔（颜色照变、箭头一动不动、一句错都不报）。
    // 变异：去掉 `onDeleteMessages` 里清待办那两行 → 最后那句 `2 / 2` 红
    // （那一版一笔都没有 → 那组箭头整组不画）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('先改一次')                 // 转盘两格（原图 + 这一版）
    await goNav('调色')
    await setSlider('亮度', 40)           // ① 起一笔、不定稿 —— 它挂在第二版上
    await goNav('修图')

    // ② 把那一版删掉（「…」→【删除】→ 确认）—— 待办该跟着它一起走
    const msgOf = (text: string) => {
      const m = [...container.querySelectorAll<HTMLElement>('.msg')].find(
        x => (x.querySelector('.bubble-text')?.textContent ?? '') === text)
      expect(m, `屏幕上没有「${text}」这条消息`).toBeTruthy()
      return m!
    }
    await tap(msgOf('好了。').querySelector('.msg-more') as HTMLButtonElement)
    await tap(msgOf('好了。').querySelector('.msg-menu-del') as HTMLButtonElement)
    await clickByText('确认删除')
    expect(container.querySelectorAll('.strip-node'), '前提：那一版真的删了').toHaveLength(1)

    // ③ 站在原图那一版上再调一下 —— 记不记得上，就看这一下
    await goNav('调色')
    await setSlider('亮度', 30)
    await waitPersist()                   // 停手 → 该定稿了
    expect(stepNav(), '记上了那一笔，才画得出这组箭头').toBeTruthy()
    expect(stepNav()!.textContent).toContain('2 / 2')
  })
})

describe('★ 步骤小图：活着时重抓 + 恢复时离屏重画（Task 8）', () => {
  it('★ 裁完一刀：当前那一版的转盘小图被重抓（而不是停在改前的样子）', async () => {
    // 变异（**验证过**）：那条 effect 加回"这一格已经有小图就收手"的早返回
    // （老形状的判据，`last.thumb` / `cur.thumb` 非空就 return）→ 这一条红
    // （实测 `expected 3 to be 4`：裁完之后一次都不重抓，那一格永远停在改之前）。
    await renderApp()
    await uploadPhoto()
    const grabbed = () => vi.mocked(thumbMod.makeThumbnail).mock.calls.length
    const before = grabbed()

    // 裁一刀：调色屏 → 工具行「裁剪」→「完成」（和「裁剪」那一组同一个入口）。
    await goNav('调色')
    const cell = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    expect(cell, '工具行里该有「裁剪」').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('完成')

    // 这一刀之后只会发生**一件**让画面变样的事：这一版的底图换成了裁过的那张
    // （id 没变、也没有新版本）—— 小图必须跟着重抓，而且只重抓这一张。
    expect(grabbed(), '裁完之后当前这一版的小图要重抓一张').toBe(before + 1)
    // 抓的是**画布**（= 这一版现在的样子），不是别的什么。
    expect(vi.mocked(thumbMod.makeThumbnail).mock.calls.at(-1)![0])
      .toBe(container.querySelector('canvas'))
  })

  it('★ 恢复会话时：每步小图按"底图 + 那一步的参数"重画（离屏管线；带 params 调 render）', async () => {
    // 3 步：exposure 0 / 1 / 2，其中第 2 步（id 3）是 `reusesPrev` —— 它和上一步
    // 是同一张图、小图直接接着用，不重画（重画只会得到肉眼一样的第二张）。
    // 变异（**验证过**两条，各自红在不同的一句上）：
    //   · 恢复那条路整个改回老形状（不建离屏管线、`thumbOf` 直接 `makeThumbnail(b)`）
    //     → ① 红（一条管线都没建）；
    //   · 只把"画"那一步摘掉（管线照建、不 `render`）→ ② 红（底图一张都没交上去）。
    //   两种情况下小图也都变样（`thumb:还没画` / `thumb:decoded-N` = "没调过色"），
    //   ③ 跟着红。
    withSessions([makeSession(7, 3, '把天调蓝一点', 'S7')])
    await renderApp()

    // ① 一整趟恢复只用**一条**临时管线 + 一张画布（≤6 步共用；spec §10 的规模控制）
    expect(pipes, '恢复这一趟建了一条（而且只有一条）离屏管线').toHaveLength(1)
    const pipe = pipes[0]!
    expect(pipe.images, '每张要重画的底图都交给了它（reusesPrev 那步不重画）')
      .toHaveLength(2)
    // ② 画的必须是**那一步的参数** —— 这正是"刷新前后长得一样"里参数那一半：
    //    拿 ZERO 画（= 老形状的底图直出）就退回"没调过色"，拿当前这一版的参数画
    //    就画错了别的步。两半都靠这一句钉住。
    expect(pipe.renders.map(r => r[0]))
      .toEqual([{ ...ZERO, exposure: 0 }, { ...ZERO, exposure: 2 }])
    // ③ 转盘上那几格的小图 = 画完参数的样子（假管线把参数写在画布上，
    //    假 `makeThumbnail` 读的就是它）—— 第 2 格接着第 1 格的，仍是同一个串。
    const srcs = [...container.querySelectorAll('img.strip-thumb')]
      .map(t => t.getAttribute('src') ?? '')
    expect(srcs).toEqual([
      'thumb:' + JSON.stringify({ ...ZERO, exposure: 0 }),
      'thumb:' + JSON.stringify({ ...ZERO, exposure: 0 }),
      'thumb:' + JSON.stringify({ ...ZERO, exposure: 2 }),
    ])
    // ④ 走完就还回去：不 `dispose` 的话每恢复一次漏一条管线 + 一张画布
    //    （而且这条路的收尾是 finally —— 失败/作废那两条也一样）。
    expect(pipe.disposed).toBe(true)
  })
})
