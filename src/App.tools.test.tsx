// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **工具那一簇**：裁剪 / 点修 / 磨皮 / 局部 / 文字 / 对比 / 按住看原图 / 图上点选。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import {
  OK,
  bodyOf,
  canvasProps,
  clickByText,
  container,
  decision,
  decodedBitmaps,
  fakeBitmap,
  fakeDecoded,
  goNav,
  lastReply,
  makeGate,
  makeSession,
  putCalls,
  renderApp,
  reopenApp,
  say,
  uploadPhoto,
  waitPersist,
  withSessions,
} from './test/appHarness'
import { act } from 'react'
import * as decodeMod from './image/decode'
import * as api from './api/client'
import * as thumbMod from './core/thumbnail'
import * as cropMod from './image/crop'
import * as straightenMod from './image/straighten'
import * as smartCropMod from './image/smartCrop'
import * as eraseMod from './image/erase'
import * as aiEraseMod from './image/aiErase'
import * as blemishMod from './image/blemish'
import * as smoothMod from './image/smooth'
import * as upscaleMod from './image/upscale'
import * as transparentMod from './image/transparency'
import * as backgroundSelectMod from './image/backgroundSelect'
import * as skyMaskMod from './image/skyMask'
import * as backgroundReplaceMod from './image/backgroundReplace'
import * as faceDetectMod from './image/faceDetect'
import * as faceShapeMod from './image/faceShape'
import * as faceLightMod from './image/faceLight'
import * as skinToneMod from './image/skinTone'
import * as makeupMod from './image/makeup'
import * as cloneMod from './image/clone'
import * as facePartMaskMod from './image/facePartMask'
import * as perspectiveMod from './image/perspective'
import * as autoPerspectiveMod from './image/autoPerspective'
import * as doubleMod from './image/doubleExposure'
import type { PerspectiveQuad } from './core/perspective'
import * as localMod from './image/localAdjust'
import * as localLayerMod from './image/localLayer'
import * as colorRangeMod from './image/colorRange'
import * as frameMod from './image/frame'
import * as canvasFrameMod from './image/canvasFrame'
import * as doodleMod from './image/doodle'
import * as lightMod from './image/light'
import * as duotoneMod from './image/duotone'
import { stampBrush } from './core/retouch'
import { ZERO } from '../shared/adjustments.ts'
import { describe, expect, it, vi } from 'vitest'

// 这个文件串行跑 122 个完整 App / React 场景；默认 5 秒在机器负载高时会让
// 单个慢用例超时，并因中断清理把后续用例一起污染。15 秒仍足以抓住真正的死循环。
vi.setConfig({ testTimeout: 15_000 })
import type { SuggestResponse } from './test/appHarness'

vi.mock('./image/autoPerspective', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image/autoPerspective')>()
  return { ...actual, detectAutoPerspective: vi.fn() }
})

// 局部层的真实掩码编解码要 2D 画布；这一层只验接线，编解码本身在
// `src/image/localLayer.test.ts` 里用假画布钉。
vi.mock('./image/localLayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image/localLayer')>()
  return {
    ...actual,
    encodeMask: vi.fn(),
    decodeMask: vi.fn(),
    preloadLocalMasks: vi.fn(async () => {}),
    applyLocalLayers: vi.fn(async () => null),
  }
})

// 色彩范围读像素 / 放大蒙版要 2D 画布；这里只验接线，判据本身在
// `src/core/colorRange.test.ts` 里用纯函数钉。
vi.mock('./image/colorRange', () => ({
  prepareColorSource: vi.fn(() => ({
    data: new Uint8ClampedArray(16), width: 2, height: 2,
  })),
  sampleColorSource: vi.fn(() => [255, 0, 0]),
  maskFromColorSource: vi.fn(
    (_src: unknown, _target: unknown, _opts: unknown, width: number, height: number) =>
      new Uint8Array(width * height).fill(128),
  ),
}))

// 明暗范围同样要在 2D 画布缓存上算；判据由 `core/luminanceRange.test.ts`
// 覆盖，这一层只验蒙版类型、控件和提交接线。
vi.mock('./image/luminanceRange', () => ({
  prepareLuminanceSource: vi.fn(() => ({
    data: new Uint8ClampedArray(16), width: 2, height: 2,
  })),
  maskFromLuminanceSource: vi.fn(
    (_src: unknown, _opts: unknown, width: number, height: number) =>
      Uint8Array.from({ length: width * height }, (_, i) => (i % 2 ? 127 : 255)),
  ),
}))

/**
 * 落盘是 800ms 防抖：图层改动会先发一趟带 `layers` 的 PUT，随后缩略图
 * 重抓还可能再补一趟不带 `layers` 的。断言"顶层 layers 送上去过"时要找
 * **带 layers 的那一趟**，不能赌它是最后一趟。
 */
async function lastPayloadWithLayers(): Promise<{ layers: unknown[] }> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const calls = putCalls('/api/sessions/1')
    // 从最后一趟往前找：通常第一趟不带、上一趟就带；不用把每一份大 body 都解析一遍。
    for (let i = calls.length - 1; i >= 0; i--) {
      const body = bodyOf(calls[i]!) as { layers?: unknown }
      if (Array.isArray(body.layers)) return body as { layers: unknown[] }
    }
    // 落盘是 800ms 防抖 + 缩略图重抓的第二趟，固定睡 900ms 在慢机器上会刚好错过。
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
  const shapes = putCalls('/api/sessions/1').map((call, index) => {
    const body = bodyOf(call) as { layers?: unknown; steps?: { layers?: unknown }[] }
    return `${index}:${body.layers === undefined ? 'no-top-layer' : 'top-layer'}` +
      `/${body.steps?.some(step => Array.isArray(step.layers)) ? 'step-layer' : 'no-step-layer'}`
  })
  expect.fail(`至少有一趟落盘带上了 layers（${shapes.join(' | ')}）`)
}

describe('★ 裁剪：框 + 第二行 + 完成 = 给当前这一版记一笔账（不加转盘格）', () => {
  /** 交给画布的裁剪现场（App 算好那一整块）。 */
  const sceneOf = () => canvasProps.props.at(-1)?.crop as {
    rect: { x: number; y: number; w: number; h: number }
    aspect: number | null
    angle: number
    inner: { x: number; y: number; w: number; h: number }
    flipH?: boolean
    flipV?: boolean
    grid?: boolean
    guide?: 'off' | 'thirds' | 'golden' | 'diagonal'
  } | null

  /** 进裁剪：先去调色屏，再点工具行那颗「裁剪」。 */
  async function openCrop() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.querySelector('.tool-row-second'), '开着裁剪时第二行该在').toBeTruthy()
  }

  /** 拨「水平矫正」（走调色面板同一个滑块零件：点数字 → 输入 → 回车）。 */
  async function setStraighten(v: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '水平矫正')!
    expect(row, '第二行该有一条「水平矫正」').toBeTruthy()
    await act(async () => {
      (row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 30))
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

  it('★ 裁完之后：**不进转盘**（只改当前这一版）、参数没被重置、画面就是裁过的那张', async () => {
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

    // ⑥ 历史里**一个格子都不多**（落盘那趟是唯一看得见 steps 的地方）：
    //   ★ 2026-10-08（账本）裁剪只改「当前这一版」—— 记一笔账、不推新快照，
    //   所以服务端那份 steps 里没有「裁剪」这一步（原来这里会多出一条）。
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])

    // ⑦ 回修图屏：**对话区一条都没多**、**转盘一格都没多** —— ★ 2026-10-08 用户
    //   定死的关系：「而不是调色区调整一份我对话区记录一份，那用户调整细节点多了
    //   不得几十个回溯点」。裁剪是调色区里的操作，它的"账"记在**当前这一版自己的
    //   账本**上（`pushEdit` 把"裁之前"压进 `past`），转盘只记对话聊出来的版本。
    //   它守两件事：**不落对话**（原来这里会多一句「裁好了。」—— 变异：把
    //   `commitCrop` 里那句 `setMessages` 加回去 → 下面两句当场红）、
    //   **不进转盘**（原来这里会多一格「裁剪」）。
    //   ⚠️ 账本那一笔现在**看不见**（翻账本的箭头是 Task 4 的产物）—— 本任务
    //   先钉"不进转盘 / 光标不挪"这两半，箭头那组断言 Task 4 补。
    await goNav('修图')
    expect(lastReply()).toBe('亮了一点。')
    expect(container.querySelectorAll('.bubble-text')).toHaveLength(3)   // 欢迎 + 你问 + 它答
    expect(container.querySelectorAll('.strip-node'), '裁剪不进转盘 —— 还是只有原图那一格')
      .toHaveLength(1)
    // 站的位置也没挪：那一格还是"你在这里"（`<span>`，点不动）—— 光标不动是这一刀的一部分
    expect(container.querySelector('.strip-node.current')?.tagName).toBe('SPAN')
    // 画面就是**裁过的那张**（裁这一刀改的是"当前这一版"，不产生新版本）
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'cropped' } })
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

  it('★ 水平 / 垂直翻转交给像素层，网格只进预览', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('水平翻转')
    await clickByText('垂直翻转')
    await clickByText('网格')
    expect(sceneOf()).toMatchObject({
      flipH: true, flipV: true, grid: true, guide: 'thirds',
    })
    await clickByText('三分')
    expect(sceneOf()?.guide).toBe('golden')
    await clickByText('黄金分割')
    expect(sceneOf()?.guide).toBe('diagonal')
    await clickByText('对角线')
    expect(sceneOf()).toMatchObject({ grid: false, guide: 'off' })
    await clickByText('完成')
    const sent = vi.mocked(cropMod.cropToBitmap).mock.calls[0]![1]
    expect(sent).toMatchObject({ flipH: true, flipV: true })
  })

  it('★ 自动水平：量到 4.2° → 水平矫正拨到 4°（0.5° 档），框跟着重置', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    vi.mocked(straightenMod.detectStraighten).mockReturnValueOnce(4.2)
    await clickByText('自动水平')
    expect(vi.mocked(straightenMod.detectStraighten)).toHaveBeenCalledTimes(1)
    const scene = sceneOf()!
    expect(scene.angle).toBe(4)
    expect(scene.rect.w).toBeLessThan(1)
    expect(scene.rect.h).toBeLessThan(1)
  })

  it('★ 自动水平找不到线 → 不硬拨，明确请用户手动拖', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    vi.mocked(straightenMod.detectStraighten).mockReturnValueOnce(null)
    await clickByText('自动水平')
    expect(sceneOf()!.angle).toBe(0)
    expect(container.textContent).toContain('没找到明显的水平线')
  })

  it('★ 智能构图：按主体位置移动裁剪框，不改比例、不提交', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('1:1')
    const before = sceneOf()!.rect
    vi.mocked(smartCropMod.detectSubjectBox).mockResolvedValueOnce({
      x0: 0.7, y0: 0.2, x1: 0.9, y1: 0.8, count: 1, ratio: 0.1,
    })

    await clickByText('智能构图')
    expect(vi.mocked(smartCropMod.detectSubjectBox)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(smartCropMod.detectSubjectBox).mock.calls[0]![0])
      .toMatchObject({ __tag: 'upload' })
    const after = sceneOf()!.rect
    expect(after.w).toBeCloseTo(before.w, 8)
    expect(after.h).toBeCloseTo(before.h, 8)
    expect(after.x).toBeGreaterThan(before.x)
    expect(after.x).toBeCloseTo(1 - before.w, 8)
    expect(vi.mocked(cropMod.cropToBitmap), '构图只是移动框，不许偷偷提交').not.toHaveBeenCalled()
  })

  it('★ 智能构图找不到主体：框不动，明确说一句', async () => {
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('1:1')
    const before = sceneOf()!.rect
    vi.mocked(smartCropMod.detectSubjectBox).mockResolvedValueOnce(null)

    await clickByText('智能构图')
    expect(sceneOf()!.rect).toEqual(before)
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('没认出主体')
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

  it('★ 站在中间那一版裁：后面那几版**原样留着**，它们的位图不还（还在用）', async () => {
    await renderApp()
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

    // 回到**原图**那一版（转盘第一格），在那儿裁。
    // ★ 2026-10-08（账本）：裁剪只改「当前这一版」，**不再切掉后面那几版** ——
    //   生成的这一版还在转盘上、随时能跳回去，所以它的位图**一张都不许关**
    //   （关了就是闪黑：跳回去时画布空着，而一句错都不报）。
    //   变异：把记账改回 `localStep`（推快照 + 切未来）→ 下面第一句当场红
    //   （那一版被切走、位图被关，而它本该还在转盘上、还点得回去）。
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await openCrop()
    await clickByText('完成')

    expect(generated.close, '后面那一版还在 —— 它的位图还在用，不许关').not.toHaveBeenCalled()

    // 转盘上还是**两格**（原图 + 生成的那一版），没有多出「裁剪」那格
    await goNav('修图')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes()).toHaveLength(2)
    // 而且生成的这一版**真的还能跳回去**（点下去画面换到它 —— 它还在）
    await act(async () => { nodes()[1]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: generated })
  })

  it('★（评审 Critical）裁完之后那一趟落盘必须**重新带底图** —— 不带就等于没裁', async () => {
    // 根因（10-08 之前的形状）：`commitCrop` 只推了 history，没推 `baseSeqRef`
    // —— 而落盘那趟当时判"底图换过没有"（`changed`）用的就是它，`patch.base` /
    // `patch.thumb` 全在 `if (changed)` 里。不推的后果**一句错都不报**：
    //   服务端手里还是没裁过的那张，重开之后画面是原图（宽高比 1.5）。
    // ★ 2026-10-08（账本，Task 7 已落地）：判据换成了**待办**
    //   （`commitCrop` 里那句 `markDirty(at, true)` = `baseChanged`，spec §7.2），
    //   底图从**那一版的干净位图**（`S(V).base.bitmap`）编码、跟着 `stateStepId`
    //   落在**那一版**上；裁剪不再产生新步骤（steps 里只有「原图」）——
    //   "新文件落在哪个新步骤上"这条旧落点随之消失，但**换了底图就要重传**
    //   这条规矩一个字没变。
    // 同一条规矩在"删掉最新一步"那边也有（那条用例钉的是封面）。
    await renderApp()
    await uploadPhoto()
    await openCrop()
    await clickByText('完成')
    // ⚠️ 这条要等 800ms 防抖 + 底图编码 + PUT 三件事；全量并发时
    //    8s 会偶发不够，等到的是前一条不带 base 的 PUT。放宽观察窗口，
    //    断言仍然是“最后那条 PUT 必须带底图”。
    await vi.waitFor(() => {
      const calls = putCalls('/api/sessions/1')
      expect(calls.length).toBeGreaterThan(0)
      expect(bodyOf(calls.at(-1)!).base).toBeTruthy()
    }, { timeout: 20_000 })

    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect(body.base, '裁剪之后那一趟必须重新带上底图').toBeTruthy()
    expect(body.thumb, '封面也要跟着换（左栏列表上显示的是"最后那张"）').toBeTruthy()
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  }, 30_000)

  it('★（评审 Important ②）同一批次里还有别的 setState 时，站中间裁照样记在**当前那一版**上（后面几版原样留着）', async () => {
    // 根因（10-08 之前）：`commitCrop` 在 `setHistory` 的 **updater 里面**读
    // `cursorIdRef.current`，而上游会把同一个 ref 改掉。React 的"eager 路径"只在
    // "这个 fiber 没有挂起的更新"时才当场跑 updater —— 一旦同一批里还有别的
    // setState，updater 就落到**渲染时**才跑、读到的已经是新值，切口跟着找错。
    // ★ 2026-10-08（账本）："切口"本身没有了（裁剪不切未来、也不挪光标），但
    //   **"这一刀冲着哪一版去的"必须在 `await` 之前当场读、传值**（`at`）这条
    //   规矩一个字没变 —— updater 什么时候跑都得认同一版。这条用例钉三件事：
    //     ① 后面那版**还在**（没被切）；② 这一刀记在**当时站的那一版**上
    //     （不是最后一版）；③ 站的位置没挪。
    // ⚠️ 必须**制造那个"别的 setState"**：平时（只有它一个）走 eager 路径，
    //    测试全绿 —— 那正是这个 Bug 一直没被测出来的原因。
    //    做法：把建议卡片那趟挂住，在裁剪那句 await 回来之前放行它
    //    （`suggesting` 由真变假 = 一个真实的 App state 更新，会占住 lane）。
    const cardsGate = makeGate<SuggestResponse>()
    vi.mocked(api.postSuggest).mockReturnValueOnce(cardsGate.promise)

    await renderApp()
    await uploadPhoto()
    // 先造出"后面那一版"：生成一版
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await say('去掉路人')
    const generated = decodedBitmaps.at(-1)!
    // 回到原图那一版（转盘第一格）—— 在那儿裁 = **站中间裁**
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await openCrop()

    // 「完成」卡在 cropToBitmap 上：先放行卡片那趟（占住 lane），再放行裁剪
    const gate = makeGate<ImageBitmap>()
    const cropped = fakeBitmap('cropped')
    vi.mocked(cropMod.cropToBitmap).mockReturnValueOnce(gate.promise)
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '完成') as HTMLButtonElement
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      cardsGate.open({ cards: [], degraded: false })
      await Promise.resolve()
      await Promise.resolve()
      gate.open(cropped)
      await new Promise(r => setTimeout(r, 0))
    })

    // 后面那一版（生成的那一版）**原样留着**：转盘上两格 = 原图 + 生成式编辑
    await goNav('修图')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes(), '站中间裁不再切后面那几版').toHaveLength(2)
    // 站的位置没挪：第一格还是"你在这里"
    expect(nodes()[0]!.className).toContain('current')
    // 这一刀记在**当时站的那一版**（原图）上，不是最后一版 —— 跳去生成的那一版：
    // 它**没被换过底图**（要是记错了版本，这里拿到的是裁出来的那张）
    await act(async () => { nodes()[1]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: generated })
    // 再跳回原图那一版：返回的是**裁过之后**的样子（这一刀落在了它身上）
    await act(async () => { nodes()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: cropped })
  })

  it('★（终审 I1）生成在裁剪那几百毫秒里落地 → 这一刀作废：账本一个字不动、不换底图、位图还回去', async () => {
    // 根因：`commitCrop` 的 `await cropToBitmap` 那几百毫秒里，生成完全可能落地
    // （推 baseSeq、换底图、推一步）。不设防的话这一刀会记到**已经不在屏上的那一版**
    // 上，`setImage` 再把它从画面上盖掉 —— 钱花了、东西没了、一句错都不报。
    // 做法照 `useGeneration` 那道 `seqAtStart` 闸门：进函数先记下当时的
    // `baseSeqRef` 和**站的位置**（`cursorIdRef`），await 回来第一件事是对它们 ——
    // 对不上就把刚裁出来的那张还回去、说一句、收掉裁剪，**账本一个字不记**
    // （连点两下「完成」也被它挡住：第二次进函数时读到的序号还是第一次推之前那个）。
    // ★ 2026-10-08（账本）：位置那半（`cursorIdRef`）是这道闸门新加的 ——
    //   裁剪只改「当前这一版」，所以"哪一版"和"哪张底图"一样必须当场钉死。
    // 变异：把闸门整条去掉 → 第一条（作废的那张没还回去）当场红；
    //   只留 `baseSeqRef` 那半、去掉位置那半 → 下面那条「人跳了版本」红
    //   （两半各守一条，10-08 实测过）。
    await renderApp()
    await uploadPhoto()

    // 生成挂住不回：它一定落在裁剪那句 await 里面
    const editGate = makeGate<typeof OK>()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockReturnValueOnce(editGate.promise)
    await say('去掉路人')

    await openCrop()
    // 「完成」也挂住：先放行生成（推步 + 换底图），再放行裁剪
    const cropGate = makeGate<ImageBitmap>()
    const cropped = fakeBitmap('cropped')
    vi.mocked(cropMod.cropToBitmap).mockReturnValueOnce(cropGate.promise)
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '完成') as HTMLButtonElement
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      editGate.open(OK)
      await new Promise(r => setTimeout(r, 0))
      cropGate.open(cropped)
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 那张裁出来的位图**还回去了**（不关就是漏 GPU 内存，和别的失败路径一个待遇）
    expect(cropped.close, '作废的那张要 close()').toHaveBeenCalled()
    // ② 不换底图：画面还是生成回来的那张 —— 裁剪盖上去 = 刚花钱买的那一版没了
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'decoded-1' } })
    // ③ 账本一个字没动、也不切：落盘那趟（唯一看得见 steps 的地方）里没有「裁剪」
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图', '生成式编辑'])
    // ④ 生成那一步的位图**没有被顺手关掉**（它还在历史里、还看得见）
    expect(decodedBitmaps.at(-1)!.close).not.toHaveBeenCalled()
    // ⑤ 说了一句（不许静默）：哪不对 + 怎么办 —— 和 I2 那句同族（"画面已经变了"）
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('画面已经变了')
    // ⑥ 裁剪收掉了（这一刀已经不成立，别留一个能对着旧框再按一次的现场）
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })

  it('★ 裁到一半**人跳了版本**（底图没换）→ 这一刀同样作废', async () => {
    // 为什么要有这道闸（10-08 新加的那半）：裁剪要的是"把结果记到**我当时站的
    // 那一版**上"，而几百毫秒里用户完全可能走开 —— 切屏会把裁剪现场收掉
    // （`[view.kind]` 那条 effect），但这一趟已经出发了；他接着在转盘上跳了版本。
    // 只看 `baseSeqRef` 的话这一刀"闸门全过"：结果记进旧那一版、`setImage` 再把
    // 画面盖到**别的版本**上 —— 光标指着 A、画面却是 B 裁出来的样子，一句错都不报。
    // 变异：闸门去掉 `cursorIdRef.current !== at` 那一半 → 第一条（作废的那张
    //   没还回去）当场红 —— 10-08 实测：只有这一条红，I1 那条照旧绿（两半各守一条）。
    await renderApp()
    await uploadPhoto()
    // 先造出"另一版"：生成一版（站的位置 = 生成那一步）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await say('去掉路人')
    const generated = decodedBitmaps.at(-1)!

    await openCrop()
    const gate = makeGate<ImageBitmap>()
    const cropped = fakeBitmap('cropped')
    vi.mocked(cropMod.cropToBitmap).mockReturnValueOnce(gate.promise)
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '完成') as HTMLButtonElement
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 0)) })

    // 裁到一半：切到修图屏（切屏会收起裁剪现场），跳到**原图**那一版
    await goNav('修图')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    await act(async () => { nodes()[0]!.click(); await new Promise(r => setTimeout(r, 0)) })

    // 放行裁剪：它回来时人已经不在那一版上了 → 作废
    await act(async () => {
      gate.open(cropped)
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 裁出来那张还回去了 ② 说了一句 ③ 画面是**跳过去的那一版**（没被盖上）
    expect(cropped.close, '作废的那张要 close()').toHaveBeenCalled()
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('画面已经变了')
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    // ④ 两版都还在、都没被换过底图（作废 ≠ 顺手把谁切了/关了）
    expect(nodes()).toHaveLength(2)
    expect(generated.close).not.toHaveBeenCalled()
  })

  it('★（终审 I3）挂着「要切掉后面吗」时裁一刀 → 条子收了（点「继续改」不许切掉后面那一版）', async () => {
    // 裁剪是**第四个换底图的地方**（前三个：`onPick` / `loadSession` / `resetEditor`
    // 各有一批"上一条照片的临时状态一起清"），而那条确认条在底图换掉之后就不成立了
    // —— 不清的话：条子停在屏上，点「继续改」的切点还落在原图上，把后面那一版
    // 切掉，条子自己还会改口说"后面还有 0 步"（自相矛盾的胡话）。
    // 变异：`commitCrop` 不清 `pendingReplace` → 这一条红（条子还在）。
    await renderApp()
    await uploadPhoto()
    // 先造出"后面还有一步"：生成一版
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await say('去掉路人')

    // 回到原图那一步再说话 —— 从旧步骤生成，先问一句
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '换个方向', reply: '好，这就去改。' }))
    await say('换个方向')
    expect(container.textContent).toContain('后面还有 1 步')

    // 挂着条子裁一刀（调色屏 → 裁剪 → 完成）
    await openCrop()
    await clickByText('完成')

    // 回修图屏：条子必须已经收了，而且**后面那一版还在**（★ 10-08：裁剪不切未来
    // —— 所以这里数到的第二格是「生成式编辑」，不是「裁剪」）
    await goNav('修图')
    expect(container.textContent).not.toContain('后面还有')
    const nodes = () => [...container.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes()).toHaveLength(2)
    // 它真的还在：点它画面回得去（没被裁这一刀连带收走）
    await act(async () => { nodes()[1]!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: decodedBitmaps[0] })
    expect(api.postEdit).toHaveBeenCalledTimes(1)   // 就那次生成 —— 「继续改」没被点过
  })
})

describe('★ 四角自由透视：裁剪里的子模式', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().perspective as {
    quad: PerspectiveQuad
    onChange: (quad: PerspectiveQuad) => void
  } | null

  async function openPerspective() {
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="裁剪"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('透视')
    expect(sceneOf(), '切到透视后四个角点交给画布').not.toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeTruthy()
  }

  it('★ 拖动四角 → 应用透视 → 换底图、参数不动、不进转盘', async () => {
    await renderApp()
    await uploadPhoto()
    await openPerspective()
    const scene = sceneOf()!
    const quad: PerspectiveQuad = [
      { x: 0.2, y: 0.1 }, { x: 0.8, y: 0.05 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.8 },
    ]
    await act(async () => {
      scene.onChange(quad)
      await new Promise(r => setTimeout(r, 0))
    })
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '应用透视') as HTMLButtonElement
    expect(done.disabled).toBe(false)
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 120)) })

    expect(vi.mocked(perspectiveMod.perspectiveToBitmap)).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'upload' }), quad)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'perspective' } })
    expect(last().params).toEqual(ZERO)
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()
    await goNav('修图')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
  })

  it('★ 自动透视：找到竖线后只改四角，用户确认后才写像素', async () => {
    await renderApp()
    await uploadPhoto()
    await openPerspective()
    const quad: PerspectiveQuad = [
      { x: 0.28, y: 0 }, { x: 0.72, y: 0 }, { x: 0.84, y: 1 }, { x: 0.16, y: 1 },
    ]
    vi.mocked(autoPerspectiveMod.detectAutoPerspective).mockResolvedValueOnce(quad)

    await act(async () => {
      await clickByText('自动透视')
      await new Promise(r => setTimeout(r, 0))
    })

    expect(vi.mocked(autoPerspectiveMod.detectAutoPerspective)).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'upload' }),
    )
    expect(sceneOf()?.quad).toEqual(quad)
    expect(vi.mocked(perspectiveMod.perspectiveToBitmap)).not.toHaveBeenCalled()
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '应用透视') as HTMLButtonElement
    expect(done.disabled).toBe(false)
  })

  it('★ 自动透视找不到竖线：四角不动，并明确请用户手动拖', async () => {
    await renderApp()
    await uploadPhoto()
    await openPerspective()
    const before = sceneOf()!.quad
    vi.mocked(autoPerspectiveMod.detectAutoPerspective).mockResolvedValueOnce(null)

    await act(async () => {
      await clickByText('自动透视')
      await new Promise(r => setTimeout(r, 0))
    })

    expect(sceneOf()!.quad).toEqual(before)
    expect(container.querySelector('.notice')?.textContent).toContain('拖四个角')
  })
})

describe('★ 点修：涂抹层 + 第二行 + 擦掉这里 = 给当前这一版记一笔账（不加转盘格）', () => {
  const last = () => canvasProps.props.at(-1)!
  /** 交给画布的点修现场（App 算好那一整块）。 */
  const sceneOf = () => last().retouch as {
    radius: number; mode: 'paint' | 'erase'; mask: Uint8Array; onMaskChange: () => void
  } | null
  const eraseButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '擦掉这里') as HTMLButtonElement

  /** 进点修：先去调色屏，再点工具行那颗「点修」。 */
  async function openRetouch() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="点修"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.querySelector('.tool-row-second'), '开着点修时第二行该在').toBeTruthy()
  }

  /** 涂一笔：走**真掩码 + 真回调**（手势本身量在 RetouchOverlay 的测试里）。 */
  async function paint(cx: number, cy: number, r: number) {
    const scene = sceneOf()!
    await act(async () => {
      stampBrush(scene.mask, 1200, 800, cx, cy, r, 'paint')
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
  }

  it('★ 擦完之后：**不进转盘**（只改当前这一版）、参数没被重置、画面就是擦过的那张', async () => {
    await renderApp()
    await uploadPhoto()
    // ① 先把亮度改到 30（本文件里"改参数"的标准写法）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30 }, reply: '亮了一点。' }))
    await say('亮一点')

    // ② 进点修：现场交下去了、掩码是当前照片的尺寸、没涂过时按钮禁用
    await openRetouch()
    const scene = sceneOf()!
    expect(scene.mask.length, '掩码必须是当前照片的尺寸').toBe(1200 * 800)
    expect(eraseButton().disabled, '还没涂过，不许按').toBe(true)

    // ③ 涂一笔 → 按钮亮
    await paint(600, 400, 40)
    expect(eraseButton().disabled).toBe(false)

    // ④ 擦
    await act(async () => { eraseButton().click(); await new Promise(r => setTimeout(r, 0)) })

    // ⑤ 送进去的是**当前底图**（upload，不是最初那张也不是别的），回来的成了新底图
    expect(vi.mocked(eraseMod.eraseToBitmap)).toHaveBeenCalledTimes(1)
    const [sent, sentMask] = vi.mocked(eraseMod.eraseToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'erased' } })

    // ⑥ 参数没丢；现场和工具一起收掉（已经不在点修了）
    expect(last().params.exposure).toBe(30)
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()

    // ⑦ 历史里**一个格子都不多**（落盘那趟是唯一看得见 steps 的地方）：
    //   ★ 2026-10-08（账本）擦除和裁剪同构 —— 只改「当前这一版」（记一笔账、
    //   不推新快照），所以 steps 里没有「擦除」这一步。
    //   ⚠️ 原来这里还钉着"本地步骤不许有 prompt"（空串会让「再来一版」出现在
    //   一颗按不动的按钮上）—— "本地步骤"这个概念随 `localStep` 一起退役了，
    //   现在 steps 只由「原图 + 生成」产生，prompt 那条账归生成那条路管。
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])

    // ⑧ 回修图屏：**对话区一条都没多**、**转盘一格都没多**（同裁剪那条，2026-10-08
    //   定的关系）；画面就是**擦过的那张**（擦这一下改的是"当前这一版"）
    await goNav('修图')
    expect(lastReply()).toBe('亮了一点。')
    expect(container.querySelectorAll('.bubble-text')).toHaveLength(3)   // 欢迎 + 你问 + 它答
    expect(container.querySelectorAll('.strip-node'), '擦除不进转盘 —— 还是只有原图那一格')
      .toHaveLength(1)
    // 站的位置也没挪：那一格还是"你在这里"（`<span>`，点不动）
    expect(container.querySelector('.strip-node.current')?.tagName).toBe('SPAN')
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'erased' } })
  })

  it('★ 兜底那条路（周围没参考、补得糊）：说一句**顶上那条通报** —— 对话区一条不多', async () => {
    // ★ 2026-10-08：擦除是调色区里的操作，不落对话记录（理由见 `commitCrop`
    //   那段注释）。但"补糊了"这件事得说出来 —— 不说用户会以为工具坏了。
    //   变异：删掉那句 `if (!usedSource) noticeBad(...)` → 第一条红；
    //   把 `setMessages` 那句加回来 → 第二条红。
    await renderApp()
    await uploadPhoto()
    vi.mocked(eraseMod.eraseToBitmap).mockResolvedValueOnce({
      bitmap: fakeBitmap('erased'), coverage: 1200, usedSource: false,
    })
    await openRetouch()
    await paint(600, 400, 40)
    await act(async () => { eraseButton().click(); await new Promise(r => setTimeout(r, 0)) })

    // ① 顶上那条通报把"糊"这件事说了
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('补得有点糊')
    // ② 对话区一条不多 —— 回修图屏数（⚠️ 调色那一屏本来就不渲染对话栏，
    //    在那屏上数 `.bubble-text` 数到的是 0）
    await goNav('修图')
    expect(container.querySelectorAll('.bubble-text')).toHaveLength(1)   // 只有欢迎语
  })

  it('★ 太大就拦：引擎一次都不跑、给一句人话、现场留着（换个小的再来）', async () => {
    // 为什么值得一条守卫：1200 万像素的照片上，外接框面积直接决定耗时
    // （探针：110 万像素 ≈ 4s）—— 上限被谁顺手删掉，用户撞上的是十几秒假死。
    await renderApp()
    // 换一张大照片（1200×800 的默认假图上最多 96 万像素，够不着 120 万的上限）
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(
      { bitmap: fakeBitmap('big'), width: 4000, height: 3000 })
    await uploadPhoto()
    await openRetouch()
    const scene = sceneOf()!
    expect(scene.mask.length).toBe(4000 * 3000)
    await act(async () => {
      // 1300×1000 = 130 万 > 上限 120 万
      for (let y = 0; y < 1000; y++) scene.mask.fill(255, y * 4000, y * 4000 + 1300)
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
    await act(async () => { eraseButton().click(); await new Promise(r => setTimeout(r, 0)) })

    expect(vi.mocked(eraseMod.eraseToBitmap), '拦住了就不许再跑引擎').not.toHaveBeenCalled()
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('一次擦一小块')
    // 现场留着：用户可以削小一点直接再来（不是被踢出去重涂）
    expect(sceneOf()).not.toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeTruthy()
  })

  it('「取消」= 什么都没发生：不跑引擎、不推步、底图不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openRetouch()
    await paint(600, 400, 40)
    await clickByText('取消')

    expect(vi.mocked(eraseMod.eraseToBitmap)).not.toHaveBeenCalled()
    // 底图还是最初那张
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(sceneOf()).toBeNull()
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })
})

// ★ 2026-10-18（AI 消除）：点修里的付费子模式。这里验的是**接线**：
//   只把当前选区周围的一块送去模型、没涂 / 太大不发请求、回图只换当前底图。
//   裁切几何和掩码回贴在 `image/aiErase.test.ts` 真算。
describe('★ AI 消除：涂选区 → 送裁切块 → 回图只改当前这一版', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().retouch as {
    radius: number; mode: 'paint' | 'erase'; mask: Uint8Array; onMaskChange: () => void
  } | null
  const aiDone = () => container.querySelector('.tool-row-second .crop-done') as HTMLButtonElement

  async function openAiErase() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="点修"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 30)) })
    const chip = [...container.querySelectorAll('.tool-row-second button')]
      .find(b => (b.textContent ?? '').trim() === 'AI 消除') as HTMLButtonElement
    expect(chip, '点修第二行该有「AI 消除」').toBeTruthy()
    await act(async () => { chip.click(); await new Promise(r => setTimeout(r, 30)) })
  }

  async function paint(cx: number, cy: number, r: number) {
    const scene = sceneOf()!
    await act(async () => {
      stampBrush(scene.mask, 1200, 800, cx, cy, r, 'paint')
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
  }

  it('★ 涂完 → 送 1024 方图 → 回图换成当前底图；参数 / 转盘都不动', async () => {
    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30 }, reply: '亮了一点。' }))
    await say('亮一点')
    vi.mocked(api.postEdit).mockResolvedValueOnce({
      imageDataUrl: 'data:image/png;base64,AIERASE', width: 1024, height: 1024,
    })

    await openAiErase()
    expect(sceneOf(), '开着 AI 消除时掩码现场该交给画布').toBeTruthy()
    expect(sceneOf()!.mask.length).toBe(1200 * 800)
    expect(aiDone().disabled, '还没涂过不许按').toBe(true)

    await paint(600, 400, 40)
    expect(aiDone().disabled).toBe(false)
    expect(container.textContent).toContain('会消耗生成额度')
    await act(async () => { aiDone().click(); await new Promise(r => setTimeout(r, 80)) })

    expect(vi.mocked(aiEraseMod.buildInpaintInput), '只做一次裁切').toHaveBeenCalledTimes(1)
    const [sentBitmap, sentMask, plan] = vi.mocked(aiEraseMod.buildInpaintInput).mock.calls[0]!
    expect(sentBitmap).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sentMask[400 * 1200 + 600]).toBeGreaterThan(0)
    expect(plan.size).toEqual({ width: 1024, height: 1024 })
    expect(plan.crop.x).toBeLessThanOrEqual(600)
    expect(plan.crop.y).toBeLessThanOrEqual(400)

    expect(vi.mocked(api.postEdit)).toHaveBeenCalledTimes(1)
    const req = vi.mocked(api.postEdit).mock.calls[0]![0]
    expect(req.width).toBe(1024)
    expect(req.height).toBe(1024)
    expect(req.editPrompt).toContain('red overlay')
    expect(req.imageDataUrl).toBe('data:image/jpeg;base64,AIERASE')

    expect(vi.mocked(aiEraseMod.compositeInpaint)).toHaveBeenCalledTimes(1)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'inpainted' } })
    expect(last().params.exposure).toBe(30)
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()
    await goNav('修图')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
  })

  it('★ 输入自定义指令 = 局部 AI 编辑；留空仍是消除', async () => {
    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postEdit).mockResolvedValueOnce({
      imageDataUrl: 'data:image/png;base64,AIEDIT', width: 1024, height: 1024,
    })
    await openAiErase()
    const prompt = container.querySelector('input[aria-label="AI 局部编辑指令"]') as HTMLInputElement
    expect(prompt).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(prompt, '把选中的地方换成一只橘猫')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await paint(600, 400, 40)
    expect(aiDone().textContent).toContain('AI 编辑')
    await act(async () => { aiDone().click(); await new Promise(r => setTimeout(r, 80)) })

    const req = vi.mocked(api.postEdit).mock.calls[0]![0]
    expect(req.editPrompt).toContain('把选中的地方换成一只橘猫')
    expect(req.editPrompt).toContain('marked area unchanged')
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'inpainted' } })
  })

  it('★ 没涂不花额度；涂满整张会被面积闸门拦下，现场留着', async () => {
    await renderApp()
    await uploadPhoto()
    await openAiErase()
    expect(aiDone().disabled).toBe(true)
    await act(async () => { aiDone().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(vi.mocked(api.postEdit)).not.toHaveBeenCalled()

    const scene = sceneOf()!
    await act(async () => {
      scene.mask.fill(255)
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
    expect(aiDone().disabled).toBe(false)
    await act(async () => { aiDone().click(); await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(api.postEdit)).not.toHaveBeenCalled()
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('太大了')
    expect(sceneOf()).toBeTruthy()
  })
})

// ★ 2026-10-17（磨皮画笔，方案二）：和点修**同构**的一整套 —— 涂抹层、第二行、
//  「磨这里」= 给当前这一版记一笔账、不占转盘格、不写对话。多出来的只有
//  「强度」那一根（0 时主按钮按不到）。
describe('★ 磨皮画笔：涂抹层 + 第二行 + 磨这里 = 给当前这一版记一笔账（不加转盘格）', () => {
  const last = () => canvasProps.props.at(-1)!
  /** 交给画布的磨皮现场（复用点修那层 `retouch` prop 的形状）。 */
  const sceneOf = () => last().retouch as {
    radius: number; mode: 'paint' | 'erase'; mask: Uint8Array; onMaskChange: () => void
  } | null
  const doneButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '磨这里') as HTMLButtonElement

  /** 进磨皮：先去调色屏，再点工具行那颗「磨皮」（面板里还有一根同名滑杆，
   *  选择器必须锁在工具行里）。 */
  async function openSmoothTool() {
    await goNav('调色')
    const cell = container.querySelector('.tool-row-main [aria-label="磨皮"]') as HTMLButtonElement
    expect(cell, '工具行该有「磨皮」那颗').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.tool-row-second'), '开着磨皮时第二行该在').toBeTruthy()
  }

  /** 涂一笔：走**真掩码 + 真回调**（手势本身量在 RetouchOverlay 的测试里）。 */
  async function paint(cx: number, cy: number, r: number) {
    const scene = sceneOf()!
    await act(async () => {
      stampBrush(scene.mask, 1200, 800, cx, cy, r, 'paint')
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
  }

  /** 拨「强度」（和裁剪那条 `setStraighten` 用同一个零件：点数字 → 输入 → 回车）。 */
  async function setStrength(v: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '强度')!
    expect(row, '第二行该有一条「强度」').toBeTruthy()
    await act(async () => {
      (row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 30))
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

  /** 拨「纹理」（同上：点数字 → 输入 → 回车）。 */
  async function setTexture(v: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '纹理')!
    expect(row, '第二行该有一条「纹理」').toBeTruthy()
    await act(async () => {
      (row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 30))
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

  it('★ 磨完之后：**不进转盘**（只改当前这一版）、参数没被重置、画面就是磨过的那张', async () => {
    await renderApp()
    await uploadPhoto()
    // ① 先把亮度改到 30（"改参数"的标准写法）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30 }, reply: '亮了一点。' }))
    await say('亮一点')

    // ② 进磨皮：现场交下去了、掩码是当前照片的尺寸、没涂过时按钮禁用
    await openSmoothTool()
    const scene = sceneOf()!
    expect(scene.mask.length, '掩码必须是当前照片的尺寸').toBe(1200 * 800)
    expect(doneButton().disabled, '还没涂过，不许按').toBe(true)

    // ③ 涂一笔 → 按钮亮（默认强度 60 > 0）
    await paint(600, 400, 40)
    expect(doneButton().disabled).toBe(false)

    // ④ 磨
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    // ⑤ 送进去的是**当前底图** + 现场那张掩码 + 默认强度 60
    expect(vi.mocked(smoothMod.smoothToBitmap)).toHaveBeenCalledTimes(1)
    const [sent, sentMask, sentOpts] = vi.mocked(smoothMod.smoothToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sentOpts!.strength).toBe(60)
    expect(sentOpts!.texture, '默认留一点皮肤纹理，别磨成塑料').toBe(35)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })

    // ⑥ 参数没丢；现场和工具一起收掉
    expect(last().params.exposure).toBe(30)
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()

    // ⑦ 历史里一个格子都不多（磨皮只改「当前这一版」）；对话区一条不多
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
    await goNav('修图')
    expect(lastReply()).toBe('亮了一点。')
    expect(container.querySelectorAll('.bubble-text')).toHaveLength(3)   // 欢迎 + 你问 + 它答
    expect(container.querySelectorAll('.strip-node'), '磨皮不进转盘 —— 还是只有原图那一格')
      .toHaveLength(1)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })
  })

  it('★ 强度调到 0：主按钮按不到（磨了等于没磨）；调回 40 又能按', async () => {
    await renderApp()
    await uploadPhoto()
    await openSmoothTool()
    await paint(600, 400, 40)
    expect(doneButton().disabled).toBe(false)

    await setStrength(0)
    expect(doneButton().disabled, '强度 0 时按了也是白按').toBe(true)

    await setStrength(40)
    expect(doneButton().disabled).toBe(false)
  })

  it('★ 纹理：滑杆真的传到引擎；100 = 原样不动，主按钮按不到', async () => {
    await renderApp()
    await uploadPhoto()
    await openSmoothTool()
    await paint(600, 400, 40)

    await setTexture(70)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })
    expect(vi.mocked(smoothMod.smoothToBitmap).mock.calls[0]![2])
      .toEqual({ strength: 60, texture: 70, radius: expect.any(Number) })

    await openSmoothTool()
    await paint(600, 400, 40)
    await setTexture(100)
    expect(doneButton().disabled, '纹理留满 = 一个像素都不动').toBe(true)
  })

  it('★ 太大就拦：引擎一次都不跑、给一句人话、现场留着（换个小的再来）', async () => {
    await renderApp()
    // 换一张大照片（1200×800 的默认假图上最多 96 万像素，够不着 120 万的上限）
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(
      { bitmap: fakeBitmap('big'), width: 4000, height: 3000 })
    await uploadPhoto()
    await openSmoothTool()
    const scene = sceneOf()!
    expect(scene.mask.length).toBe(4000 * 3000)
    await act(async () => {
      // 1300×1000 = 130 万 > 上限 120 万
      for (let y = 0; y < 1000; y++) scene.mask.fill(255, y * 4000, y * 4000 + 1300)
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    expect(vi.mocked(smoothMod.smoothToBitmap), '拦住了就不许再跑引擎').not.toHaveBeenCalled()
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('一次磨一小块')
    // 现场留着：用户可以削小一点直接再来
    expect(sceneOf()).not.toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeTruthy()
  })

  it('「取消」= 什么都没发生：不跑引擎、不推步、底图不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openSmoothTool()
    await paint(600, 400, 40)
    await clickByText('取消')

    expect(vi.mocked(smoothMod.smoothToBitmap)).not.toHaveBeenCalled()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(sceneOf()).toBeNull()
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })
})

// ★ 2026-10-17（局部调整）：和磨皮/点修同构，第二行提供局部调色滑杆。
describe('★ 克隆图章：选源点 + 涂抹 + 应用克隆', () => {
  const last = () => canvasProps.props.at(-1)!
  const cloneScene = () => last().clone as {
    radius: number
    source: { x: number; y: number } | null
    offset: { x: number; y: number } | null
    onStroke: (points: { x: number; y: number }[]) => void
  } | null
  const doneButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '应用克隆') as HTMLButtonElement

  async function openCloneTool() {
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('克隆')
    expect(container.querySelector('.tool-row-second'), '开着克隆时第二行该在').toBeTruthy()
  }

  it('★ 选源点 → 第一笔定偏移 → 应用后换底图、参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openCloneTool()
    expect(doneButton().disabled, '还没选源点、没涂过时不许按').toBe(true)

    await clickByText('选源点')
    expect(last().sampling, '选源点时画布进入取样').toBe(true)
    expect(cloneScene(), '取样时先收起涂抹层').toBeNull()
    await act(async () => {
      last().onSamplePoint!(0.25, 0.5)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(last().sampling).toBe(false)
    expect(cloneScene()?.source).toMatchObject({ x: 299.75, y: 399.5 })

    await act(async () => {
      cloneScene()!.onStroke([{ x: 700, y: 400 }, { x: 900, y: 400 }])
      await new Promise(r => setTimeout(r, 30))
    })
    expect(vi.mocked(cloneMod.cloneToBitmap)).toHaveBeenCalledTimes(1)
    const [src, strokes, maxSide] = vi.mocked(cloneMod.cloneToBitmap).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.points).toEqual([{ x: 700, y: 400 }, { x: 900, y: 400 }])
    expect(strokes[0]!.radius).toBeGreaterThan(0)
    expect(strokes[0]!.offset).toMatchObject({ x: -400.25, y: -0.5 })
    expect(maxSide).toBe(1400)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'clone-preview' } })
    expect(doneButton().disabled).toBe(false)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    expect(vi.mocked(cloneMod.cloneToBitmap)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(cloneMod.cloneToBitmap).mock.calls[1]![2]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'clone' } })
    expect(last().params).toEqual(ZERO)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })
})

describe('★ 人像：本地人脸框 + 瘦脸 / 大眼 / 瘦鼻 / 下巴', () => {
  const last = () => canvasProps.props.at(-1)!
  const doneButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '应用人像') as HTMLButtonElement

  async function openPortrait() {
    await goNav('调色')
    const cell = container.querySelector('.tool-row-main [aria-label="人像"]') as HTMLButtonElement
    expect(cell, '工具行该有「人像」那颗').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.querySelector('.tool-row-second'), '开着人像时第二行该在').toBeTruthy()
  }

  async function setPortraitSlider(label: string, value: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === label)!
    expect(row, `第二行该有一条「${label}」`).toBeTruthy()
    await act(async () => {
      ;(row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const box = row.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(box, String(value))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 识别到脸 → 滑杆出预览 → 应用后换底图、参数不动、不进转盘', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    expect(vi.mocked(faceDetectMod.detectFacesInBitmap)).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'upload' }),
      6,
    )
    expect(last().faceShape?.face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(doneButton().disabled, '还没拉滑杆时不许按').toBe(true)

    await setPortraitSlider('瘦脸', 60)
    await setPortraitSlider('小头', 30)
    await setPortraitSlider('颅顶', 50)
    await setPortraitSlider('瘦鼻', 40)
    await setPortraitSlider('微笑', 40)
    await setPortraitSlider('瘦颈', 35)
    await setPortraitSlider('双下巴', 45)
    await setPortraitSlider('直角肩', 25)
    await setPortraitSlider('瘦身', 50)
    await setPortraitSlider('长腿', 70)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    // 连续改十根滑杆时，机器慢一点可能已经跨过一次 120ms 防抖；
    // 产品承诺的是**最后一次预览**用完整参数，而不是一连串输入只能算一次。
    const previewCalls = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls
    expect(previewCalls.length).toBeGreaterThanOrEqual(1)
    const [, face, opts, maxSide] = previewCalls.at(-1)!
    expect(face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(opts).toEqual({
      slim: 60, head: 30, crown: 50, eyes: 0, nose: 40, chin: 0, smile: 40,
      body: 50, legs: 70, neck: 35, doubleChin: 45, shoulder: 25,
    })
    expect(maxSide).toBe(1400)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'portrait-preview' } })
    expect(doneButton().disabled).toBe(false)

    const callsBeforeApply = previewCalls.length
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    expect(vi.mocked(faceShapeMod.faceShapeToBitmap)).toHaveBeenCalledTimes(callsBeforeApply + 1)
    const [, , fullOpts, fullMaxSide] = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls.at(-1)!
    expect(fullOpts).toEqual({
      slim: 60, head: 30, crown: 50, eyes: 0, nose: 40, chin: 0, smile: 40,
      body: 50, legs: 70, neck: 35, doubleChin: 45, shoulder: 25,
    })
    expect(fullMaxSide).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'portrait' } })
    expect(last().params).toEqual(ZERO)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })

  it('★ 合影有多张脸：可以切到第二张，预览和成片都用选中的脸框', async () => {
    const secondFace = { x: 720, y: 160, w: 360, h: 460, confidence: 0.84 }
    vi.mocked(faceDetectMod.detectFacesInBitmap).mockResolvedValueOnce([
      { x: 300, y: 120, w: 420, h: 520, confidence: 0.9 },
      secondFace,
    ])
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    const picker = container.querySelector('[aria-label="选择人脸"]')
    expect(picker, '两张脸时该出现选脸入口').toBeTruthy()
    const chips = [...picker!.querySelectorAll('button')]
    expect(chips.map(b => b.textContent?.trim())).toEqual(['全部', '脸 1', '脸 2'])
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(last().faceShape?.face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })

    await act(async () => {
      last().faceShape!.onPickFace!(1)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(chips[2]!.getAttribute('aria-pressed')).toBe('true')
    expect(last().faceShape?.face).toMatchObject(secondFace)

    await setPortraitSlider('瘦脸', 35)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls.at(-1)![1])
      .toMatchObject(secondFace)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const full = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls.at(-1)!
    expect(full[1]).toMatchObject(secondFace)
    expect(full[3]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'portrait' } })
  })

  it('★ 全部脸：同一组参数逐脸应用，身体关系只做一次', async () => {
    const secondFace = { x: 720, y: 160, w: 360, h: 460, confidence: 0.84 }
    vi.mocked(faceDetectMod.detectFacesInBitmap).mockResolvedValueOnce([
      { x: 300, y: 120, w: 420, h: 520, confidence: 0.9 },
      secondFace,
    ])
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    await clickByText('全部')
    expect(last().faceShape?.all).toBe(true)
    expect(last().faceShape?.faces).toHaveLength(2)

    await setPortraitSlider('瘦脸', 35)
    await setPortraitSlider('瘦颈', 20)
    await setPortraitSlider('磨皮', 30)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })

    const previewCalls = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls
    expect(previewCalls).toHaveLength(2)
    expect(previewCalls[0]![1]).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(previewCalls[0]![2]).toMatchObject({ slim: 35, neck: 20 })
    expect(previewCalls[1]![1]).toMatchObject(secondFace)
    expect(previewCalls[1]![2]).toEqual({
      slim: 35, head: 0, crown: 0, eyes: 0, nose: 0, chin: 0, smile: 0,
    })
    expect(vi.mocked(smoothMod.smoothToBitmap)).toHaveBeenCalledTimes(1)
    const mask = vi.mocked(smoothMod.smoothToBitmap).mock.calls[0]![1]
    expect(mask[390 * 1200 + 510]).toBeGreaterThan(0)
    expect(mask[390 * 1200 + 900]).toBeGreaterThan(0)
    expect(mask[400 * 1200 + 100]).toBe(0)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 120)) })
    const fullCalls = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls
    expect(fullCalls).toHaveLength(4)
    expect(fullCalls[2]![1]).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(fullCalls[3]![1]).toMatchObject(secondFace)
    expect(fullCalls[3]![2]).not.toHaveProperty('neck')
    expect(vi.mocked(smoothMod.smoothToBitmap)).toHaveBeenCalledTimes(2)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })

  it('★ 一键美颜：给出一套自然起点，预览和应用走同一组值', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()
    expect(doneButton().disabled, '还没动过时不许按').toBe(true)

    await clickByText('一键美颜')
    expect(doneButton().disabled).toBe(false)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })

    expect(vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls.at(-1)![2])
      .toEqual({
        slim: 6, head: 0, crown: 0, eyes: 5, nose: 3, chin: 4, smile: 5,
        body: 0, legs: 0, neck: 0, doubleChin: 0, shoulder: 0,
      })
    expect(vi.mocked(smoothMod.smoothToBitmap).mock.calls.at(-1)![2])
      .toEqual({ strength: 22, texture: 35 })
    expect(vi.mocked(blemishMod.blemishToBitmap).mock.calls.at(-1)![2])
      .toEqual({ strength: 70 })
    expect(vi.mocked(faceLightMod.faceLightToBitmap).mock.calls.at(-1)![2])
      .toEqual({ strength: 30 })
    expect(vi.mocked(skinToneMod.skinToneToBitmap).mock.calls.at(-1)![2])
      .toEqual({ whiten: 12, rosy: 8 })
    expect(vi.mocked(makeupMod.makeupToBitmap).mock.calls.at(-1)![2])
      .toMatchObject({ lip: 10, blush: 8 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'makeup-preview' } })

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const full = vi.mocked(faceShapeMod.faceShapeToBitmap).mock.calls.at(-1)!
    expect(full[2]).toEqual({
      slim: 6, head: 0, crown: 0, eyes: 5, nose: 3, chin: 4, smile: 5,
      body: 0, legs: 0, neck: 0, doubleChin: 0, shoulder: 0,
    })
    expect(full[3]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'makeup' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 人像磨皮只作用在脸框内：软边蒙版交给 smoothToBitmap', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()
    await setPortraitSlider('磨皮', 30)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })

    expect(vi.mocked(smoothMod.smoothToBitmap)).toHaveBeenCalledTimes(1)
    const [previewSrc, previewMask, previewOpts] = vi.mocked(smoothMod.smoothToBitmap).mock.calls[0]!
    expect(previewSrc).toMatchObject({ __tag: 'portrait-preview' })
    expect(previewMask.length).toBe(1200 * 800)
    expect(previewMask[400 * 1200 + 510]).toBe(255)
    expect(previewMask[0]).toBe(0)
    expect(previewOpts).toEqual({ strength: 30, texture: 35 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const [fullSrc, fullMask, fullOpts] = vi.mocked(smoothMod.smoothToBitmap).mock.calls.at(-1)!
    expect(fullSrc).toMatchObject({ __tag: 'upload' })
    expect(fullMask.length).toBe(1200 * 800)
    expect(fullOpts).toEqual({ strength: 30, texture: 35 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 去斑：脸框内检测后逐点修补，只改当前这一版', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()
    expect(vi.mocked(blemishMod.blemishToBitmap)).not.toHaveBeenCalled()

    await clickByText('去斑')
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(blemishMod.blemishToBitmap)).toHaveBeenCalledTimes(1)
    const [previewSrc, previewFace, previewOpts] = vi.mocked(blemishMod.blemishToBitmap).mock.calls[0]!
    expect(previewSrc).toMatchObject({ __tag: 'portrait-preview' })
    expect(previewFace).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(previewOpts).toEqual({ strength: 70 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'blemished' } })

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    expect(vi.mocked(blemishMod.blemishToBitmap).mock.calls.at(-1)![0])
      .toMatchObject({ __tag: 'upload' })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'blemished' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 去斑没找到斑点：当场说清空结果，不把开关留在无反应的状态', async () => {
    vi.mocked(faceShapeMod.faceShapeToBitmap).mockImplementationOnce(
      async (_src: ImageBitmap, face, _opts, maxSide) => ({
        bitmap: fakeBitmap(maxSide ? 'portrait-preview' : 'portrait'),
        changed: 0,
        scale: maxSide ? 0.6 : 1,
        face,
      }))
    vi.mocked(blemishMod.blemishToBitmap).mockResolvedValueOnce({
      bitmap: fakeBitmap('blemish-empty'), spots: 0, healed: 0, usedSource: false,
    })
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    await clickByText('去斑')
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })

    expect(container.querySelector('.tool-note')?.textContent ?? '')
      .toContain('没找到明显的小斑点')
    expect(doneButton().disabled, '画面没有变化，就不该允许写进底图').toBe(true)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })

  it('★ 没认到正脸：留在人像工具里，手动拖框后可以继续修', async () => {
    vi.mocked(faceDetectMod.detectFacesInBitmap).mockResolvedValueOnce([])
    vi.mocked(faceDetectMod.detectFaceInBitmap).mockResolvedValueOnce(null)
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="人像"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 30))
    })

    expect(container.querySelector('.tool-note')?.textContent ?? '').toContain('拖一个脸框')
    expect(container.querySelector('.tool-row-second')).toBeTruthy()
    expect(last().faceShape).toBeNull()
    expect(last().facePick).not.toBeNull()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(vi.mocked(faceShapeMod.faceShapeToBitmap)).not.toHaveBeenCalled()

    const manual = { x: 320, y: 150, w: 360, h: 470, confidence: 1 }
    await act(async () => {
      last().facePick!.onPick(manual)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(last().facePick).toBeNull()
    expect(last().faceShape?.face).toMatchObject(manual)
    expect(container.querySelector('.tool-note')?.textContent ?? '').toContain('按正脸估计')

    await setPortraitSlider('磨皮', 20)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(smoothMod.smoothToBitmap)).toHaveBeenCalledTimes(1)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'smoothed' } })
  })

  it('★ 重选脸：自动框认错了可以手动改正，再继续调', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()
    expect(last().faceShape?.face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })

    await clickByText('重选脸')
    expect(last().faceShape).toBeNull()
    expect(last().facePick).not.toBeNull()
    const corrected = { x: 520, y: 180, w: 320, h: 420, confidence: 1 }
    await act(async () => {
      last().facePick!.onPick(corrected)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(last().faceShape?.face).toMatchObject(corrected)
  })

  it('★ 口红 / 腮红：预览走 makeupToBitmap，应用后换底图、参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    await setPortraitSlider('口红', 70)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(makeupMod.makeupToBitmap)).toHaveBeenCalledTimes(1)
    const [, , opts, maxSide] = vi.mocked(makeupMod.makeupToBitmap).mock.calls[0]!
    expect(opts).toMatchObject({ lip: 70, blush: 0, lipShade: 'rose' })
    expect(maxSide).toBe(1400)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'makeup-preview' } })

    // 换色号 → 同一张预览重算，色号真的传下去
    await clickByText('珊瑚')
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(makeupMod.makeupToBitmap).mock.calls.at(-1)![2])
      .toMatchObject({ lipShade: 'coral' })

    // 再加腮红 → 一起进同一张预览
    await setPortraitSlider('腮红', 45)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(makeupMod.makeupToBitmap).mock.calls.at(-1)![2])
      .toMatchObject({ lip: 70, blush: 45, lipShade: 'coral' })

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const full = vi.mocked(makeupMod.makeupToBitmap).mock.calls.at(-1)!
    expect(full[2]).toMatchObject({ lip: 70, blush: 45, lipShade: 'coral' })
    expect(full[3]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'makeup' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 面部补光：预览走 faceLightToBitmap，应用后换底图、参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    await setPortraitSlider('补光', 60)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(faceLightMod.faceLightToBitmap)).toHaveBeenCalledTimes(1)
    const [, face, opts, maxSide] = vi.mocked(faceLightMod.faceLightToBitmap).mock.calls[0]!
    expect(face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(opts).toEqual({ strength: 60 })
    expect(maxSide).toBe(1400)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'face-light-preview' } })
    expect(doneButton().disabled).toBe(false)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const full = vi.mocked(faceLightMod.faceLightToBitmap).mock.calls.at(-1)!
    expect(full[2]).toEqual({ strength: 60 })
    expect(full[3]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'face-light' } })
    expect(last().params).toEqual(ZERO)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })

  it('★ 肤色：美白 / 红润走 skinToneToBitmap，应用后只改当前底图', async () => {
    await renderApp()
    await uploadPhoto()
    await openPortrait()

    await setPortraitSlider('美白', 55)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(skinToneMod.skinToneToBitmap)).toHaveBeenCalledTimes(1)
    const [, face, opts, maxSide] = vi.mocked(skinToneMod.skinToneToBitmap).mock.calls[0]!
    expect(face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(opts).toEqual({ whiten: 55, rosy: 0 })
    expect(maxSide).toBe(1400)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'skin-tone-preview' } })

    await setPortraitSlider('红润', 40)
    await act(async () => { await new Promise(r => setTimeout(r, 180)) })
    expect(vi.mocked(skinToneMod.skinToneToBitmap).mock.calls.at(-1)![2])
      .toEqual({ whiten: 55, rosy: 40 })

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const full = vi.mocked(skinToneMod.skinToneToBitmap).mock.calls.at(-1)!
    expect(full[2]).toEqual({ whiten: 55, rosy: 40 })
    expect(full[3]).toBeUndefined()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'skin-tone' } })
    expect(last().params).toEqual(ZERO)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })
})

describe('★ 局部调整：涂抹层 + 局部调色滑杆 + 应用局部 = 只改当前这一版的底图', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().retouch as {
    radius: number; mode: 'paint' | 'erase'; mask: Uint8Array; onMaskChange: () => void
  } | null
  const gradientSceneOf = () => last().gradient as {
    spec: {
      kind: 'linear' | 'radial'
      start: { x: number; y: number }
      end: { x: number; y: number }
      feather: number
    }
    onChange: (spec: {
      kind: 'linear' | 'radial'
      start: { x: number; y: number }
      end: { x: number; y: number }
      feather: number
    }) => void
  } | null
  const doneButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '应用局部') as HTMLButtonElement

  async function openLocalTool() {
    await goNav('调色')
    const cell = container.querySelector('.tool-row-main [aria-label="局部"]') as HTMLButtonElement
    expect(cell, '工具行该有「局部」那颗').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.tool-row-second'), '开着局部时第二行该在').toBeTruthy()
  }

  async function paint(cx: number, cy: number, r: number) {
    const scene = sceneOf()!
    await act(async () => {
      stampBrush(scene.mask, 1200, 800, cx, cy, r, 'paint')
      scene.onMaskChange()
      await new Promise(res => setTimeout(res, 0))
    })
  }

  async function setLocalSlider(label: string, v: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === label)!
    expect(row, `第二行该有一条「${label}」`).toBeTruthy()
    await act(async () => {
      ;(row.querySelector('.slider-value') as HTMLElement).click()
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

  it('★ 应用之后：底图换成局部调整那张、全局参数没动、不进转盘、不写对话', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    const scene = sceneOf()!
    expect(scene.mask.length).toBe(1200 * 800)
    expect(doneButton().disabled, '还没涂过、也没调过，不许按').toBe(true)

    await paint(600, 400, 40)
    await setLocalSlider('亮度', 40)
    expect(doneButton().disabled).toBe(false)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    expect(vi.mocked(localMod.localAdjustToBitmap)).toHaveBeenCalledTimes(1)
    const [sent, sentMask, sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sentOpts).toMatchObject({ exposure: 40, contrast: 0, saturation: 0, temperature: 0 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '局部亮度不许写进全局参数').toBe(0)
    expect(sceneOf()).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()

    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
    await goNav('修图')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
  })

  it('★ 局部调色值全 0：主按钮按不到；调一个就能按', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    expect(doneButton().disabled, '涂过但调色值全 0 = 调了等于没调').toBe(true)
    await setLocalSlider('饱和度', 30)
    expect(doneButton().disabled).toBe(false)
    await setLocalSlider('饱和度', 0)
    expect(doneButton().disabled).toBe(true)
  })

  it('★ 反选：主体选区翻成背景选区，背景虚化只作用于原来没涂的地方', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    const scene = sceneOf()!
    expect(scene.mask[400 * 1200 + 600]).toBe(255)

    await clickByText('反选')
    expect(sceneOf()!.mask[400 * 1200 + 600]).toBe(0)
    expect(sceneOf()!.mask[0]).toBe(255)

    await clickByText('模糊')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const [, sentMask, sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[400 * 1200 + 600]).toBe(0)
    expect(sentMask[0]).toBe(255)
    expect(sentOpts).toEqual({ effect: 'blur', effectStrength: 60 })
  })

  it('★ 羽化：提交前把画笔选区边缘柔化，中心硬覆盖降低', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('模糊')
    await setLocalSlider('羽化', 100)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, sentMask] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[400 * 1200 + 600]).toBeGreaterThan(0)
    expect(sentMask[400 * 1200 + 600]).toBeLessThan(255)
    expect(sentMask[400 * 1200 + 680]).toBeGreaterThan(0)
  })

  it('★ 扩边：涂抹的掩码在提交前外扩，原来圈外一点也进掩码', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 10)
    await setLocalSlider('扩边', 10)
    await setLocalSlider('亮度', 30)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, sentMask] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[400 * 1200 + 615], '外扩 10px 后这一点该进掩码').toBeGreaterThan(0)
    expect(sentMask[400 * 1200 + 640], '再远就还是圈外').toBe(0)
  })

  it('★ 不透明度：50% 时掩码覆盖率减半；0 时主按钮按不到', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)

    await setLocalSlider('不透明度', 0)
    expect(doneButton().disabled, '不透明度 0 = 做了等于没做').toBe(true)
    await setLocalSlider('不透明度', 50)
    await setLocalSlider('亮度', 30)
    expect(doneButton().disabled).toBe(false)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, sentMask] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[400 * 1200 + 600]).toBeGreaterThan(100)
    expect(sentMask[400 * 1200 + 600]).toBeLessThan(160)
  })

  it('★ 局部高光 / 阴影：滑杆真的传进引擎，不写全局参数', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('高光', -40)
    await setLocalSlider('阴影', 35)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toMatchObject({ effect: 'tone', highlights: -40, shadows: 35 })
    expect(last().params.highlights, '局部高光不许写进全局参数').toBe(0)
    expect(last().params.shadows, '局部阴影不许写进全局参数').toBe(0)
  })

  it('★ 减淡 / 加深：选亮度范围后提交同一笔局部层，不写全局参数', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)

    expect(container.textContent).toContain('减淡')
    expect(container.textContent).toContain('加深')
    await clickByText('减淡')
    const effects = container.querySelector('[aria-label="局部效果"]')
    const range = container.querySelector('[aria-label="明暗范围"]')
    expect(range, '减淡要有亮度范围').toBeTruthy()
    expect(effects?.nextElementSibling, '明暗范围要紧跟效果按钮，别藏在滑杆后面').toBe(range)
    await clickByText('阴影')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'dodge', effectStrength: 60, toneRange: 'shadows',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params, '减淡 / 加深不许写进全局参数').toEqual(ZERO)
  })

  it('★ 局部自然饱和度 / 清晰度：滑杆进引擎，全局参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('自然饱和度', 50)
    await setLocalSlider('清晰度', 40)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toMatchObject({ effect: 'tone', vibrance: 50, clarity: 40 })
    expect(last().params.vibrance).toBe(0)
    expect(last().params.clarity).toBe(0)
  })

  it('★ 局部色调：绿—洋红滑杆进引擎，全局白平衡不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('色调', -30)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toMatchObject({ effect: 'tone', tint: -30 })
    expect(last().params.tint).toBe(0)
  })

  it('★ 局部白色 / 黑色色阶：端点控制进引擎，全局亮度不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('白色色阶', -40)
    await setLocalSlider('黑色色阶', 35)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toMatchObject({ effect: 'tone', whites: -40, blacks: 35 })
    expect(last().params.whites).toBe(0)
    expect(last().params.blacks).toBe(0)
  })

  it('★ 局部去雾：滑杆进引擎，只改选区且不写全局去雾', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('去雾', 45)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 100)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toMatchObject({ effect: 'tone', dehaze: 45 })
    expect(last().params.dehaze).toBe(0)
  })

  it('★ 牙齿模式：涂过即可提亮去黄，强度 0 时按不到', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('牙齿')

    expect(doneButton().disabled, '默认强度 60 + 涂过 = 可按').toBe(false)
    await setLocalSlider('强度', 0)
    expect(doneButton().disabled, '强度 0 = 做了等于没做').toBe(true)
    await setLocalSlider('强度', 80)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'teeth', effectStrength: 80 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '牙齿效果不许写进全局参数').toBe(0)
  })

  it('★ 祛皱模式：涂过即可提交柔和细纹预设，全局参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('祛皱')

    expect(doneButton().disabled, '默认强度 60 + 涂过 = 可提交').toBe(false)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [sent, sentMask, sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sentOpts).toEqual({ effect: 'wrinkle', effectStrength: 60 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 去反光模式：涂过即可提交高光压缩预设，全局参数不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('去反光')

    expect(doneButton().disabled, '默认强度 60 + 涂过 = 可提交').toBe(false)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [sent, sentMask, sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sentOpts).toEqual({ effect: 'antiglare', effectStrength: 60 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 亮眼模式：走同一条局部账本，提交的是亮眼预设', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('亮眼')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'eyes', effectStrength: 60 })
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })

  it('★ 红眼模式：涂抹后提交红眼预设，强度可调', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('红眼')
    await setLocalSlider('强度', 100)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'redeye', effectStrength: 100 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
  })

  it('★ 发色模式：涂过 + 选酒红 + 应用，提交发色与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 200, 60)
    await clickByText('发色')
    expect(container.querySelector('[aria-label="发色"]'), '发色色板该出来').toBeTruthy()
    await clickByText('酒红')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'hair', effectStrength: 60, hairShade: 'wine',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '发色不许写进全局参数').toBe(0)
  })

  it('★ 眼影模式：涂过 + 选玫瑰粉 + 应用，提交眼影与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 160, 50)
    await clickByText('眼影')
    expect(container.querySelector('[aria-label="眼影色号"]'), '眼影色板该出来').toBeTruthy()
    await clickByText('玫瑰粉')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'eyeshadow', effectStrength: 60, eyeShadowShade: 'rose',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '眼影不许写进全局参数').toBe(0)
  })

  it('★ 卧蚕模式：涂过 + 选香槟 + 应用，提交卧蚕与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 200, 40)
    await clickByText('卧蚕')
    expect(container.querySelector('[aria-label="卧蚕色号"]'), '卧蚕色板该出来').toBeTruthy()
    await clickByText('香槟')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'aegyoSal', effectStrength: 60, aegyoSalShade: 'champagne',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '卧蚕不许写进全局参数').toBe(0)
  })

  it('★ 眼线模式：涂过 + 选深棕 + 应用，提交眼线与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 150, 24)
    await clickByText('眼线')
    expect(container.querySelector('[aria-label="眼线色号"]'), '眼线色板该出来').toBeTruthy()
    await clickByText('深棕')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'eyeliner', effectStrength: 60, eyelinerShade: 'brown',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '眼线不许写进全局参数').toBe(0)
  })

  it('★ 美瞳模式：涂过 + 选冰蓝 + 应用，提交美瞳与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 160, 22)
    await clickByText('美瞳')
    expect(container.querySelector('[aria-label="美瞳色号"]'), '美瞳色板该出来').toBeTruthy()
    await clickByText('冰蓝')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'iris', effectStrength: 60, irisShade: 'blue',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '美瞳不许写进全局参数').toBe(0)
  })

  it('★ 眉毛模式：涂过 + 选红棕 + 应用，提交眉毛与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 120, 50)
    await clickByText('眉毛')
    expect(container.querySelector('[aria-label="眉毛色号"]'), '眉毛色板该出来').toBeTruthy()
    await clickByText('红棕')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'eyebrow', effectStrength: 60, eyebrowShade: 'auburn',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '眉毛不许写进全局参数').toBe(0)
  })

  it('★ 修容模式：涂过 + 选暖棕 + 应用，提交修容与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 300, 60)
    await clickByText('修容')
    expect(container.querySelector('[aria-label="修容色号"]'), '修容色板该出来').toBeTruthy()
    await clickByText('暖棕')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'contour', effectStrength: 60, contourShade: 'warm',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '修容不许写进全局参数').toBe(0)
  })

  it('★ 高光模式：涂过 + 选珍珠 + 应用，提交高光与色号', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 260, 40)
    await clickByText('高光')
    expect(container.querySelector('[aria-label="高光色号"]'), '高光色板该出来').toBeTruthy()
    await clickByText('珍珠')
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'highlight', effectStrength: 60, highlightShade: 'pearl',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params.exposure, '高光不许写进全局参数').toBe(0)
  })

  it('★ 自动眼 / 自动牙：正脸框生成局部掩码，直接提交对应效果', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()

    await clickByText('自动眼')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(facePartMaskMod.selectFacePartToMask)).toHaveBeenCalledTimes(1)
    const [src, face, part, mask] = vi.mocked(facePartMaskMod.selectFacePartToMask).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(face).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(part).toBe('eyes')
    expect(mask.length).toBe(1200 * 800)
    expect(doneButton().disabled, '自动选区后应该能应用').toBe(false)

    await clickByText('自动牙')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(facePartMaskMod.selectFacePartToMask).mock.calls[1]![2]).toBe('teeth')
    await setLocalSlider('强度', 80)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })
    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'teeth', effectStrength: 80 })
  })

  it('★ 自动眼下：正脸框圈出泪沟，提交黑眼圈预设', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()

    await clickByText('自动眼下')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const call = vi.mocked(facePartMaskMod.selectFacePartToMask).mock.calls[0]!
    expect(call[1]).toMatchObject({ x: 300, y: 120, w: 420, h: 520 })
    expect(call[2]).toBe('undereye')
    expect(doneButton().disabled, '自动选区后应该能应用').toBe(false)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })
    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'darkcircle', effectStrength: 60 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(last().params, '黑眼圈不许写进全局参数').toEqual(ZERO)
  })

  it('★ 自动主体 / 背景 / 天空：一键写入局部蒙版，仍可继续手修', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()

    await clickByText('自动主体')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(backgroundSelectMod.selectSubjectToMask)).toHaveBeenCalledTimes(1)
    expect(sceneOf()!.mask[400 * 1200 + 600]).toBeGreaterThan(0)
    expect(sceneOf()!.mask[0]).toBe(0)

    await clickByText('自动背景')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(backgroundSelectMod.selectSubjectToMask)).toHaveBeenCalledTimes(2)
    expect(sceneOf()!.mask[0]).toBe(255)
    expect(sceneOf()!.mask[400 * 1200 + 600]).toBe(0)

    await clickByText('自动天空')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(vi.mocked(skyMaskMod.selectSkyToMask)).toHaveBeenCalledTimes(1)
    expect(sceneOf()!.mask[10 * 1200 + 600]).toBeGreaterThan(0)
    expect(sceneOf()!.mask[700 * 1200 + 600]).toBe(0)
  })

  it('★ 一键虚化背景：本机估主体 → 只虚化背景 → 换底图并收工具', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()

    await clickByText('一键虚化背景')
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })

    expect(vi.mocked(backgroundSelectMod.selectSubjectToMask)).toHaveBeenCalledTimes(1)
    const [source, sentMask, sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(source).toMatchObject({ __tag: 'upload' })
    expect(sentMask[0], '左上角是背景，要进虚化掩码').toBeGreaterThan(0)
    expect(sentMask[400 * 1200 + 600], '主体中心要保持清楚').toBe(0)
    expect(sentOpts).toEqual({ effect: 'blur', effectStrength: 65 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(last().params).toEqual(ZERO)
  })

  it('★ 模糊 / 马赛克：同一条局部账本，提交对应模式', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('模糊')
    await clickByText('马赛克')
    await setLocalSlider('强度', 70)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 0)) })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({ effect: 'mosaic', effectStrength: 70 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'localized' } })
  })

  it('★ 动感模糊：角度 / 强度进引擎，不写全局参数', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await clickByText('动感模糊')
    await setLocalSlider('强度', 60)
    await setLocalSlider('角度', 90)
    await act(async () => {
      doneButton().click()
      await new Promise(r => setTimeout(r, 0))
    })

    const [, , sentOpts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentOpts).toEqual({
      effect: 'motionBlur', effectStrength: 60, angle: 90,
    })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 线性渐变蒙版：拖出的范围和羽化真的写进局部掩码', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('线性')
    expect(sceneOf(), '切到渐变后不再走画笔层').toBeNull()
    const gradient = gradientSceneOf()!
    expect(gradient.spec.kind).toBe('linear')

    await act(async () => {
      gradient.onChange({
        kind: 'linear',
        start: { x: 0.5, y: 0.2 },
        end: { x: 0.5, y: 0.8 },
        feather: 0,
      })
      await new Promise(r => setTimeout(r, 0))
    })
    await setLocalSlider('亮度', 40)
    // 渐变蒙版面积大，会先盖一帧「正在算」再调引擎；等它真的发出去。
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 120)) })

    const [, sentMask] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[Math.floor(800 * 0.05) * 1200 + 600]).toBe(255)
    expect(sentMask[Math.floor(800 * 0.95) * 1200 + 600]).toBe(0)
  })

  it('★ 径向渐变蒙版：圆心全生效、四角归零，羽化滑杆可改', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('径向')
    const gradient = gradientSceneOf()!
    expect(gradient.spec.kind).toBe('radial')
    await setLocalSlider('羽化', 30)
    await act(async () => {
      gradient.onChange({
        kind: 'radial',
        start: { x: 0.5, y: 0.5 },
        end: { x: 0.9, y: 0.5 },
        feather: 0.3,
      })
      await new Promise(r => setTimeout(r, 0))
    })
    await setLocalSlider('对比度', 30)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 120)) })

    const [, sentMask] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(sentMask[Math.floor(800 * 0.5) * 1200 + 600]).toBe(255)
    expect(sentMask[0], '左上角在外半径之外').toBe(0)
  })

  it('「取消」= 什么都没发生：不跑引擎、底图不动、现场收掉', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('色温', 20)
    await clickByText('取消')

    expect(vi.mocked(localMod.localAdjustToBitmap)).not.toHaveBeenCalled()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(sceneOf()).toBeNull()
  })

  it('★ 抠图：点修里切到透明擦除，涂过之后产出带 alpha 的新底图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')

    const scene = sceneOf()!
    expect(scene.mask.length).toBe(1200 * 800)
    await paint(600, 400, 40)
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '擦成透明') as HTMLButtonElement
    expect(done.disabled).toBe(false)
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(vi.mocked(transparentMod.transparentToBitmap)).toHaveBeenCalledTimes(1)
    const [sent, sentMask] = vi.mocked(transparentMod.transparentToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'transparent' } })
    expect(last().params).toEqual(ZERO)
    expect(sceneOf()).toBeNull()
  })

  it('★ 一键选背景：点背景取样 → 自动填掩码 → 擦成透明', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')
    await clickByText('点背景')
    expect(canvasProps.props.at(-1)?.sampling, '点背景后进入画布取样').toBe(true)
    expect(sceneOf(), '取样时先收起涂抹层').toBeNull()

    const sample = canvasProps.props.at(-1)!.onSamplePoint!
    await act(async () => {
      sample(0.2, 0.5)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(vi.mocked(backgroundSelectMod.selectBackgroundToMask)).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'upload' }),
      expect.any(Uint8Array),
      0.2, 0.5, 24,
    )
    expect(canvasProps.props.at(-1)?.sampling).toBe(false)
    expect(sceneOf(), '选完背景后画笔层回来，可以继续修边').not.toBeNull()

    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '擦成透明') as HTMLButtonElement
    expect(done.disabled).toBe(false)
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 120)) })
    const [, sentMask] = vi.mocked(transparentMod.transparentToBitmap).mock.calls[0]!
    expect(sentMask[0]).toBe(255)
    expect(sentMask[sentMask.length - 1]).toBe(0)
  })

  it('★ 智能主体：填背景掩码后可以直接换白底', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')
    await clickByText('智能主体')

    expect(vi.mocked(backgroundSelectMod.selectSubjectToMask)).toHaveBeenCalledTimes(1)
    const [source, sentMask] = vi.mocked(backgroundSelectMod.selectSubjectToMask).mock.calls[0]!
    expect(source).toMatchObject({ __tag: 'upload' })
    expect(sentMask.length).toBe(1200 * 800)
    expect(sceneOf(), '识别完画笔层要回来，允许继续修边').not.toBeNull()

    const select = container.querySelector('.tool-row-second select[aria-label="背景"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'white'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '换背景') as HTMLButtonElement
    expect(done.disabled).toBe(false)
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 120)) })

    expect(vi.mocked(backgroundReplaceMod.replaceBackgroundToBitmap)).toHaveBeenCalledTimes(1)
    const [sent, mask, fill] = vi.mocked(backgroundReplaceMod.replaceBackgroundToBitmap).mock.calls[0]!
    expect(sent).toMatchObject({ __tag: 'upload' })
    expect(mask.length).toBe(1200 * 800)
    expect(fill).toEqual({ kind: 'color', color: '#ffffff' })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'replaced' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 天空预设：本地生成日落背景，不改参数', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')
    await clickByText('智能主体')
    const select = container.querySelector('.tool-row-second select[aria-label="背景"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'sky-sunset'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await setLocalSlider('缩放', 140)
    await setLocalSlider('左右', 50)
    await setLocalSlider('上下', -25)
    const flip = [...container.querySelectorAll('.tool-row-second button')]
      .find(b => (b.textContent ?? '').trim() === '翻转') as HTMLButtonElement
    await act(async () => { flip.click(); await new Promise(r => setTimeout(r, 0)) })
    const done = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '换背景') as HTMLButtonElement
    await act(async () => { done.click(); await new Promise(r => setTimeout(r, 120)) })

    const fill = vi.mocked(backgroundReplaceMod.replaceBackgroundToBitmap).mock.calls[0]![2]
    expect(fill).toMatchObject({
      kind: 'sky', preset: 'sunset',
      transform: { scale: 1.4, flip: true },
    })
    if (fill.kind === 'sky') {
      expect(fill.transform.x).toBeCloseTo(0.1)
      expect(fill.transform.y).toBeCloseTo(-0.05)
    }
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'replaced' } })
    expect(last().params).toEqual(ZERO)
  })

  it('★ 虚化原背景和自定义图片都走同一条换背景提交', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')
    await clickByText('智能主体')

    const select = container.querySelector('.tool-row-second select[aria-label="背景"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'blur'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    const blurDone = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '换背景') as HTMLButtonElement
    await act(async () => { blurDone.click(); await new Promise(r => setTimeout(r, 120)) })
    expect(vi.mocked(backgroundReplaceMod.replaceBackgroundToBitmap).mock.calls[0]![2])
      .toEqual({ kind: 'blur' })

    // 再来一次，换成用户自己的背景图。
    await act(async () => {
      ;(container.querySelector('.tool-row-main [aria-label="点修"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('抠图')
    await clickByText('智能主体')
    const select2 = container.querySelector('.tool-row-second select[aria-label="背景"]') as HTMLSelectElement
    await act(async () => {
      select2.value = 'image'
      select2.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    const imageDone = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '换背景') as HTMLButtonElement
    expect(imageDone.disabled, '还没选背景图时不许按').toBe(true)

    const file = new File(['bg'], 'bg.png', { type: 'image/png' })
    const input = container.querySelector(
      '.tool-row-second input[type="file"]',
    ) as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    const readyDone = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '换背景') as HTMLButtonElement
    expect(readyDone.disabled).toBe(false)
    await act(async () => { readyDone.click(); await new Promise(r => setTimeout(r, 120)) })

    const fill = vi.mocked(backgroundReplaceMod.replaceBackgroundToBitmap).mock.calls[1]![2]
    expect(fill.kind).toBe('image')
    if (fill.kind === 'image') expect(fill.bitmap).toMatchObject({ __tag: 'upload' })
  })

  it('★ 可回改局部层：存为层不改底图；回来改 / 更新 / 删除都记一笔', async () => {
    vi.mocked(localLayerMod.encodeMask).mockResolvedValue({
      mask: 'data:image/png;base64,LOCAL', maskWidth: 300, maskHeight: 200,
    })
    vi.mocked(localLayerMod.decodeMask).mockImplementation(
      async (_layer, width, height) => new Uint8Array(width * height),
    )
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('亮度', 40)

    const save = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '存为层') as HTMLButtonElement
    expect(save, '局部第二行该有「存为层」').toBeTruthy()
    await act(async () => { save.click(); await new Promise(r => setTimeout(r, 30)) })

    expect(canvasProps.images.at(-1), '存为层不许换底图').toMatchObject({
      bitmap: { __tag: 'upload' },
    })
    const saved = (last().layers as {
      kind: string; id: string; options: { exposure?: number }
    }[]).find(l => l.kind === 'local')!
    expect(saved.options.exposure).toBe(40)
    expect(vi.mocked(localLayerMod.encodeMask)).toHaveBeenCalledTimes(1)

    // 回来改：点「局部层 1」→ 掩码和参数接回现场
    await openLocalTool()
    await clickByText('局部层 1')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(vi.mocked(localLayerMod.decodeMask)).toHaveBeenCalledTimes(1)
    expect(sceneOf(), '接回来的层要有可涂的掩码').not.toBeNull()
    const exposureRow = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '亮度')!
    expect(exposureRow.querySelector('.slider-value')?.textContent).toBe('40')

    await setLocalSlider('亮度', 60)
    const update = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '更新层') as HTMLButtonElement
    expect(update, '回改时主按钮叫「更新层」').toBeTruthy()
    await act(async () => { update.click(); await new Promise(r => setTimeout(r, 30)) })

    const locals = (last().layers as {
      kind: string; id: string; options: { exposure?: number }
    }[]).filter(l => l.kind === 'local')
    expect(locals).toHaveLength(1)
    expect(locals[0]!.id).toBe(saved.id)
    expect(locals[0]!.options.exposure).toBe(60)

    // 删除也记一笔
    await openLocalTool()
    const del = container.querySelector(
      '.tool-row-second [aria-label="删除局部层 1"]',
    ) as HTMLButtonElement
    expect(del).toBeTruthy()
    await act(async () => { del.click(); await new Promise(r => setTimeout(r, 0)) })
    expect((last().layers as { kind: string }[]).some(l => l.kind === 'local')).toBe(false)
  })

  it('★ 不透明度随局部层保存，回来还能改', async () => {
    vi.mocked(localLayerMod.encodeMask).mockResolvedValue({
      mask: 'data:image/png;base64,FADE', maskWidth: 300, maskHeight: 200,
    })
    vi.mocked(localLayerMod.decodeMask).mockImplementation(
      async (_layer, width, height) => new Uint8Array(width * height),
    )
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await paint(600, 400, 40)
    await setLocalSlider('不透明度', 60)
    await setLocalSlider('亮度', 20)
    await setLocalSlider('色调', -25)
    await act(async () => {
      ( [...container.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '存为层') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 30))
    })

    const saved = (last().layers as {
      kind: string
      opacity?: number
      options?: Record<string, unknown>
    }[])
      .find(l => l.kind === 'local')!
    expect(saved.opacity).toBe(60)
    expect(saved.options?.tint).toBe(-25)

    await openLocalTool()
    await clickByText('局部层 1')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const opacityRow = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '不透明度')!
    expect(opacityRow.querySelector('.slider-value')?.textContent).toBe('60')
    const tintRow = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '色调')!
    expect(tintRow.querySelector('.slider-value')?.textContent).toBe('-25')
  })

  it('★ 色彩范围：点选颜色 → 容差 / 羽化 → 应用局部', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('色彩范围')

    const pick = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '点选颜色') as HTMLButtonElement
    expect(pick, '色彩范围该有「点选颜色」').toBeTruthy()
    expect(doneButton().disabled, '还没点颜色时不许应用').toBe(true)
    await act(async () => { pick.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(last().sampling, '点了「点选颜色」后画布进入取色').toBe(true)

    await act(async () => {
      last().onSamplePoint!(0.5, 0.4)
      await new Promise(r => setTimeout(r, 10))
    })
    expect(last().sampling).toBe(false)
    expect(vi.mocked(colorRangeMod.prepareColorSource)).toHaveBeenCalled()
    expect(vi.mocked(colorRangeMod.sampleColorSource))
      .toHaveBeenLastCalledWith(expect.anything(), 0.5, 0.4)
    expect([...container.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').trim() === '重新点颜色')).toBe(true)

    // 反选：色彩范围也支持；选中状态要亮着
    await clickByText('反选')
    const invertButton = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '反选')!
    expect(invertButton.getAttribute('aria-pressed')).toBe('true')

    await setLocalSlider('容差', 60)
    expect(vi.mocked(colorRangeMod.maskFromColorSource).mock.calls.at(-1)![2])
      .toMatchObject({ tolerance: 60, feather: 35 })
    await setLocalSlider('羽化', 50)
    expect(vi.mocked(colorRangeMod.maskFromColorSource).mock.calls.at(-1)![2])
      .toMatchObject({ tolerance: 60, feather: 50 })

    await setLocalSlider('亮度', 30)
    expect(doneButton().disabled, '选了范围 + 有调色值才能应用').toBe(false)
    // 整片蒙版走「慢的那一档」：两次 rAF 之后才开算。
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const [, mask, opts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(mask).toHaveLength(1200 * 800)
    expect(mask[0], '反选后 128 变 127').toBe(127)
    expect(opts).toMatchObject({ exposure: 30 })
    expect(last().params.exposure, '色彩范围也不许写进全局参数').toBe(0)
  })

  it('★ 明暗范围：按高光选区、调范围与羽化，应用后不写全局参数', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()

    const toneMask = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '明暗')
    expect(toneMask, '局部蒙版该有「明暗」范围').toBeTruthy()
    await act(async () => {
      (toneMask as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 10))
    })

    const toneGroup = container.querySelector('[aria-label="明暗范围"]') as HTMLElement
    expect(toneGroup).toBeTruthy()
    expect([...toneGroup.querySelectorAll('button')]
      .map(b => (b.textContent ?? '').trim()))
      .toEqual(['阴影', '中间调', '高光'])
    await act(async () => {
      ([...toneGroup.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '高光') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 10))
    })
    await setLocalSlider('范围', 55)
    await setLocalSlider('羽化', 40)
    await setLocalSlider('亮度', 25)

    expect(doneButton().disabled, '选好范围 + 有调色值才能应用').toBe(false)
    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const [, mask, opts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(mask).toHaveLength(1200 * 800)
    expect(new Set(mask).size, '明暗范围应是软选区，不是整片硬填').toBeGreaterThan(1)
    expect(opts).toMatchObject({ exposure: 25 })
    expect(last().params.exposure, '明暗范围也不许写进全局参数').toBe(0)
  })

  it('★ 明暗范围可回改：存层后回来，预设 / 范围 / 羽化都还在', async () => {
    vi.mocked(localLayerMod.encodeMask).mockResolvedValueOnce({
      mask: 'data:image/png;base64,TONE', maskWidth: 600, maskHeight: 400,
    })
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('明暗')
    const group = container.querySelector('[aria-label="明暗范围"]') as HTMLElement
    await act(async () => {
      ([...group.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '中间调') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 10))
    })
    await setLocalSlider('范围', 62)
    await setLocalSlider('羽化', 44)
    await setLocalSlider('亮度', 20)
    await clickByText('存为层')

    const saved = (last().layers as {
      kind: string
      luminance?: Record<string, unknown>
    }[]).find(layer => layer.kind === 'local')
    expect(saved?.luminance).toMatchObject({
      range: 'midtones', width: 62, feather: 44,
    })

    await openLocalTool()
    await clickByText('局部层 1')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const reopened = container.querySelector('[aria-label="明暗范围"]') as HTMLElement
    expect([...reopened.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '中间调')
      ?.getAttribute('aria-pressed')).toBe('true')
    const valueOf = (label: string) => [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === label)
      ?.querySelector('.slider-value')?.textContent
    expect(valueOf('范围')).toBe('62')
    expect(valueOf('羽化')).toBe('44')
  })

  it('★ 相连区域：点哪块只长哪块，点击种子随局部层保存', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('色彩范围')
    await clickByText('相连区域')

    const pick = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '点选颜色') as HTMLButtonElement
    await act(async () => { pick.click(); await new Promise(r => setTimeout(r, 0)) })
    await act(async () => {
      last().onSamplePoint!(0.35, 0.6)
      await new Promise(r => setTimeout(r, 10))
    })
    expect(vi.mocked(colorRangeMod.maskFromColorSource).mock.calls.at(-1)![2])
      .toMatchObject({ connected: true, seedX: 0.35, seedY: 0.6 })

    vi.mocked(localLayerMod.encodeMask).mockResolvedValueOnce({
      mask: 'data:image/png;base64,AAAA',
      maskWidth: 600,
      maskHeight: 400,
    })
    await setLocalSlider('亮度', 25)
    await clickByText('存为层')
    const saved = (last().layers as {
      kind: string
      color?: { connected?: boolean; seed?: number[] }
    }[]).find(layer => layer.kind === 'local')
    expect(saved?.color).toMatchObject({
      connected: true,
      seed: [0.35, 0.6],
    })
  })

  it('★ 保留颜色：一键反选色彩范围 + 饱和度 -100，点色后只留主色', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('保留颜色')

    expect(last().sampling, '点完「保留颜色」直接进入取色').toBe(true)
    expect([...container.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').trim() === '点照片上的颜色…')).toBe(true)
    expect([...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '饱和度')
      ?.querySelector('.slider-value')?.textContent).toBe('-100')
    expect(doneButton().disabled, '还没点颜色时不许应用').toBe(true)

    await act(async () => {
      last().onSamplePoint!(0.5, 0.4)
      await new Promise(r => setTimeout(r, 10))
    })
    expect(last().sampling).toBe(false)
    expect(doneButton().disabled).toBe(false)

    await act(async () => { doneButton().click(); await new Promise(r => setTimeout(r, 80)) })
    const [, mask, opts] = vi.mocked(localMod.localAdjustToBitmap).mock.calls[0]!
    expect(mask[0], '反选后 128 变 127').toBe(127)
    expect(opts).toMatchObject({ effect: 'tone', saturation: -100 })
    expect(last().params.saturation, '保留颜色也不写全局参数').toBe(0)
  })

  it('★ 保留颜色：点到灰色不乱去色，提示换一块有颜色的地方', async () => {
    await renderApp()
    await uploadPhoto()
    await openLocalTool()
    await clickByText('保留颜色')
    vi.mocked(colorRangeMod.sampleColorSource).mockReturnValueOnce([128, 128, 128])

    await act(async () => {
      last().onSamplePoint!(0.5, 0.4)
      await new Promise(r => setTimeout(r, 10))
    })
    expect(last().sampling, '还在取色，用户可以继续点').toBe(true)
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('太灰')
    expect(doneButton().disabled).toBe(true)
  })
})

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

  it('★ 一个屏只有一个入口：调色屏是工具行那颗、修图屏是右下角那颗（同一个开关）', async () => {
    await renderApp()
    await uploadPhoto()

    // ── 调色屏：工具行是**唯一**入口 —— 右下角那颗的回调**故意不给**
    //   （画布拿它当"画不画那颗按钮"的判据）。2026-10-07 设计评审：两颗并排
    //   是同一开关的两种长相，读起来像两个功能，用户拍板去掉一个。
    await goNav('调色')
    expect(last().onCompare, '调色屏不该再给右下角那颗 —— 工具行才是这一屏的入口').toBeUndefined()
    await clickCell()
    expect(last().comparing, '工具行那颗照样开得起来').toBe(true)
    await clickCell()
    expect(last().comparing).toBe(false)

    // ── 修图屏：没有工具行，右下角那颗照旧在 —— 回调还是**同一个开关**
    await goNav('修图')
    const onCompare = last().onCompare
    expect(onCompare, '修图屏要把右下角那颗的回调交给画布').toBeTypeOf('function')
    await act(async () => { onCompare!(); await new Promise(r => setTimeout(r, 0)) })
    expect(last().comparing).toBe(true)
    await act(async () => { last().onCompare!(); await new Promise(r => setTimeout(r, 0)) })
    expect(last().comparing).toBe(false)
  })

  it('★ 恢复出来的会话照样能对比（原图从那一条路来）', async () => {
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    await renderApp()
    await goNav('调色')
    await clickCell()
    expect(last().compareWith).toMatch(/^original:/)
  })
})

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
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValue(fakeDecoded(tag))
    await reopenApp()
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

describe('★ 文字：写在当前这一版底图上，账本记一笔', () => {
  const openText = async () => {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="文字"]') as HTMLButtonElement
    expect(cell, '工具行里该有「文字」').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.tool-row-second'), '开着文字时第二行该在').toBeTruthy()
  }

  const typeText = async (value: string) => {
    const box = container.querySelector('[aria-label="文字内容"]') as HTMLTextAreaElement
    expect(box, '第二行该有一个文字输入框').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(box, value)
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  const doneButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '加上文字') as HTMLButtonElement

  const setTextSlider = async (label: string, value: number) => {
    const row = [...container.querySelectorAll('.slider')].find(node =>
      (node.querySelector('.slider-label')?.textContent ?? '').trim() === label)
    expect(row, `文字工具该有「${label}」滑杆`).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const box = row!.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(box, String(value))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  const textLayers = () => (canvasProps.props.at(-1)?.layers ?? []) as {
    id: string; options: Record<string, unknown>
  }[]

  it('★ 输入内容 → 预览现场交下去 →「加上文字」加一层、收工具、不进转盘', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('你好')
    await clickByText('宋体')

    // 预览现场（内容 / 居中 / 默认字号与白字）已经交给画布
    expect(canvasProps.props.at(-1)?.text).toMatchObject({
      options: { text: '你好', x: 0.5, y: 0.5, fontPx: 64, font: 'serif', color: '#ffffff' },
    })

    await clickByText('加上文字')

    expect(textLayers()).toHaveLength(1)
    expect(textLayers()[0]!.options).toMatchObject({
      text: '你好', x: 0.5, y: 0.5, fontPx: 64, font: 'serif', color: '#ffffff',
    })
    // 底图一个像素都没被烤；文字层单独存在，工具现场收掉
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.text).toBeNull()

    // 只改当前这一版：服务端 steps 里仍然只有「原图」那一格
    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
    expect((body.steps as { layers?: unknown[] }[])[0]!.layers).toHaveLength(1)
    expect((await lastPayloadWithLayers()).layers).toHaveLength(1)
  })

  it('★ 文字模板：点「标题」按短边放大字号并加粗 / 阴影，内容不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('旅行')
    await clickByText('标题')

    const opts = (canvasProps.props.at(-1)?.text as { options: Record<string, unknown> }).options
    expect(opts.text).toBe('旅行')
    expect(opts.fontPx).toBe(80)   // 1200×800 的短边 800 × 0.10
    expect(opts.bold).toBe(true)
    expect(opts.shadow).toBe(true)
    expect(opts.color).toBe('#ffffff')

    await clickByText('杂志')
    const mag = (canvasProps.props.at(-1)?.text as { options: Record<string, unknown> }).options
    expect(mag.background).toBe(true)
    expect(mag.backgroundOpacity).toBe(68)
    expect(mag.text).toBe('旅行')
  })

  it('★ 文字层可以回来改、也可以删；底图始终不动', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('第一层')
    await clickByText('加上文字')
    const base = canvasProps.images.at(-1)

    await openText()
    await typeText('第二层')
    await clickByText('加上文字')
    expect(textLayers()).toHaveLength(2)

    await openText()
    await clickByText('第一层')
    const box = container.querySelector('[aria-label="文字内容"]') as HTMLTextAreaElement
    expect(box.value).toBe('第一层')
    await typeText('第一层改过')
    await clickByText('更新文字')
    expect(textLayers()).toHaveLength(2)
    expect(textLayers().map(layer => layer.options.text)).toEqual(['第一层改过', '第二层'])
    expect(canvasProps.images.at(-1)).toBe(base)

    await openText()
    await clickByText('第一层改过')
    await clickByText('删除这层')
    expect(textLayers()).toHaveLength(1)
    expect(textLayers()[0]!.options.text).toBe('第二层')
    expect(canvasProps.images.at(-1)).toBe(base)
  })

  it('★ 裁剪会把文字层合并进底图并清空层；退一步能回来', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('裁前')
    await clickByText('加上文字')
    const base = canvasProps.images.at(-1)

    const crop = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => { crop.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('完成')

    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'cropped' } })
    expect(textLayers()).toHaveLength(0)

    const undo = container.querySelector('[aria-label="上一步"]') as HTMLButtonElement
    await act(async () => { undo.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(canvasProps.images.at(-1)).toBe(base)
    expect(textLayers()).toHaveLength(1)
    expect(textLayers()[0]!.options.text).toBe('裁前')
  })

  it('★ 文字旋转：调角度后预览和成片都收到同一个值', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('斜着')
    await setTextSlider('旋转', 30)

    expect(canvasProps.props.at(-1)?.text).toMatchObject({
      options: { text: '斜着', rotation: 30 },
    })
    await clickByText('加上文字')
    expect(textLayers()[0]!.options).toMatchObject({
      text: '斜着', rotation: 30,
    })
  })

  it('★ 文字行距 / 字距：控件值与预览、成片一致', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('排版')
    await setTextSlider('行距', 1.6)
    await setTextSlider('字距', 20)

    expect(canvasProps.props.at(-1)?.text).toMatchObject({
      options: { text: '排版', lineHeight: 1.6, letterSpacing: 20 },
    })
    await clickByText('加上文字')
    expect(textLayers()[0]!.options).toMatchObject({
      text: '排版', lineHeight: 1.6, letterSpacing: 20,
    })
  })

  it('★ 空内容不许多按一下；取消 = 什么都没发生', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()

    expect(doneButton().disabled, '空文字时「加上文字」该是灰的').toBe(true)
    await typeText('   ')
    expect(doneButton().disabled, '只有空格也算空').toBe(true)

    await clickByText('取消')
    expect(textLayers()).toHaveLength(0)
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })

  it('★ 统一图层面板：显隐 / 上移 / 点名字回来改 / 删除都走账本', async () => {
    await renderApp()
    await uploadPhoto()
    await openText()
    await typeText('第一')
    await clickByText('加上文字')
    await openText()
    await typeText('第二')
    await clickByText('加上文字')

    const layersNow = () => (canvasProps.props.at(-1)?.layers ?? []) as {
      id: string; visible?: boolean; options: { text?: string }
    }[]
    const rows = () => [...container.querySelectorAll('.layer-row')]
    expect(rows().map(row => row.querySelector('.layer-name')?.textContent)).toEqual([
      '文字 · 第二', '文字 · 第一',
    ])
    const topId = layersNow()[1]!.id

    // 眼睛 = 暂时不画；层还在，参数一起留着
    await act(async () => {
      (rows()[0]!.querySelector('.layer-eye') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(layersNow().find(layer => layer.id === topId)?.visible).toBe(false)

    // 点名字 = 回来改（开文字工具，内容接回现场）
    await act(async () => {
      (rows()[1]!.querySelector('.layer-name') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(canvasProps.props.at(-1)?.text).toMatchObject({ options: { text: '第一' } })

    // 上移第一层：数组里它跑到第二层后面（盖在上面）
    await act(async () => {
      (container.querySelector('[aria-label="上移文字 · 第一"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(layersNow().map(layer => layer.options.text)).toEqual(['第二', '第一'])

    // 删除也记一笔；正开着这层的编辑现场会一起收掉
    await act(async () => {
      (container.querySelector('[aria-label="删除文字 · 第一"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(layersNow().map(layer => layer.options.text)).toEqual(['第二'])
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })
})

describe('★ 边框：预览四条边，应用后写进当前底图', () => {
  it('★ 选拍立得 → 预览现场 →「应用边框」换底图、收工具、不进转盘', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    const cell = container.querySelector('[aria-label="装饰"]') as HTMLButtonElement
    expect(cell, '工具行里该有「装饰」').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.tool-row-second')).toBeTruthy()
    expect(canvasProps.props.at(-1)?.frame).toMatchObject({
      options: { style: 'solid', color: '#ffffff', widthPct: 4 },
    })

    await clickByText('拍立得')
    expect(canvasProps.props.at(-1)?.frame).toMatchObject({ options: { style: 'polaroid' } })
    await clickByText('应用边框')

    expect(vi.mocked(frameMod.frameToBitmap)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(frameMod.frameToBitmap).mock.calls[0]![0]).toMatchObject({ __tag: 'upload' })
    expect(vi.mocked(frameMod.frameToBitmap).mock.calls[0]![1]).toMatchObject({
      style: 'polaroid', color: '#ffffff', widthPct: 4,
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'framed' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.frame).toBeNull()

    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })
})

describe('★ 画布：单张照片扩成社交比例，背景可纯色 / 模糊 / 透明', () => {
  const setCanvasSlider = async (label: string, value: number) => {
    const row = [...container.querySelectorAll('.tool-row-second .slider')].find(node =>
      (node.querySelector('.slider-label')?.textContent ?? '').trim() === label)
    expect(row, `画布工具该有「${label}」滑杆`).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const input = row!.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 装饰 → 画布 → 4:5 + 模糊 + 边距 10 → 应用后写进当前底图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const cell = container.querySelector('[aria-label="装饰"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('画布')

    expect(canvasProps.props.at(-1)?.canvasFrame).toMatchObject({
      options: {
        aspect: '1:1', background: 'color', color: '#ffffff', paddingPct: 0,
      },
    })
    await clickByText('4:5')
    await clickByText('模糊')
    await setCanvasSlider('边距', 10)
    expect(canvasProps.props.at(-1)?.canvasFrame).toMatchObject({
      options: {
        aspect: '4:5', background: 'blur', color: '#ffffff', paddingPct: 10,
      },
    })

    await clickByText('应用画布')
    const [src, opts] = vi.mocked(canvasFrameMod.canvasFrameToBitmap).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(opts).toEqual({
      aspect: '4:5', background: 'blur', color: '#ffffff', paddingPct: 10,
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'canvas-frame' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.canvasFrame).toBeNull()
  })
})

describe('★ 贴纸：装饰工具里的第二种模式', () => {
  it('★ 装饰 → 贴纸 → 加一层、回来改、删除；底图始终不动', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    const openSticker = async () => {
      const cell = container.querySelector('[aria-label="装饰"]') as HTMLButtonElement
      await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
      await clickByText('贴纸')
    }
    const stickerLayers = () => (canvasProps.props.at(-1)?.layers ?? []) as {
      kind: string; options: Record<string, unknown>; image?: string | null
    }[]

    await openSticker()
    expect(canvasProps.props.at(-1)?.sticker).toMatchObject({
      options: { shape: 'star', sizePct: 18, rotation: 0, color: '#ffffff' },
    })
    await clickByText('心')
    await clickByText('正片叠底')
    expect(canvasProps.props.at(-1)?.sticker).toMatchObject({
      options: { shape: 'heart', blend: 'multiply', opacity: 100 },
    })
    await clickByText('应用贴纸')

    expect(stickerLayers()).toHaveLength(1)
    expect(stickerLayers()[0]).toMatchObject({
      kind: 'sticker',
      options: {
        shape: 'heart', x: 0.5, y: 0.5, sizePct: 18, rotation: 0, color: '#ffffff',
        blend: 'multiply', opacity: 100,
      },
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.sticker).toBeNull()

    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { layers?: unknown[] }[])[0]!.layers).toHaveLength(1)
    expect((await lastPayloadWithLayers()).layers).toHaveLength(1)

    await openSticker()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="点击改这张贴纸"]')!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('闪电')
    await clickByText('更新贴纸')
    expect(stickerLayers()).toHaveLength(1)
    expect(stickerLayers()[0]!.options.shape).toBe('lightning')

    await openSticker()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="点击改这张贴纸"]')!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('删除这层')
    expect(stickerLayers()).toHaveLength(0)
  })
})

describe('★ 形状：装饰工具里的新成员', () => {
  it('★ 装饰 → 形状 → 加一层、回来改、删除；底图始终不动', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    const openShape = async () => {
      const cell = container.querySelector('[aria-label="装饰"]') as HTMLButtonElement
      await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
      await clickByText('形状')
    }
    const shapeLayers = () => (canvasProps.props.at(-1)?.layers ?? []) as {
      kind: string; options: Record<string, unknown>
    }[]

    await openShape()
    expect(canvasProps.props.at(-1)?.shape).toMatchObject({
      options: {
        kind: 'rect', x1: 0.18, y1: 0.2, x2: 0.82, y2: 0.8,
        color: '#ff3b30', strokePct: 0.8, fill: false, opacity: 100,
      },
    })
    await clickByText('椭圆')
    await clickByText('填充')
    await clickByText('正片叠底')
    expect(canvasProps.props.at(-1)?.shape).toMatchObject({
      options: { kind: 'ellipse', fill: true, blend: 'multiply' },
    })
    await clickByText('应用形状')

    expect(shapeLayers()).toHaveLength(1)
    expect(shapeLayers()[0]).toMatchObject({
      kind: 'shape',
      options: {
        kind: 'ellipse', fill: true, opacity: 100, blend: 'multiply',
      },
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
    expect(container.querySelector('.tool-row-second')).toBeNull()
    expect(canvasProps.props.at(-1)?.shape).toBeNull()

    await waitPersist()
    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect((body.steps as { layers?: unknown[] }[])[0]!.layers).toHaveLength(1)
    expect((await lastPayloadWithLayers()).layers).toHaveLength(1)

    await openShape()
    await clickByText('椭圆')
    await clickByText('矩形')
    await clickByText('更新形状')
    expect(shapeLayers()).toHaveLength(1)
    expect(shapeLayers()[0]!.options).toMatchObject({
      kind: 'rect', fill: true, opacity: 100, blend: 'multiply',
    })

    await openShape()
    await clickByText('矩形')
    await clickByText('删除这层')
    expect(shapeLayers()).toHaveLength(0)
  })
})

describe('★ AI 扩图：从裁剪进去，生成后成为新的一版', () => {
  it('选 4:5 → 送扩过画布的提示词 → 成功后收工具、画面上换成新底图', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await goNav('调色')

    const crop = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => {
      crop.click()
      await new Promise(r => setTimeout(r, 30))
    })
    await clickByText('AI 扩图')
    expect(container.textContent).toContain('生成扩图')
    expect(container.textContent).toContain('生成后是新的一版，可撤销')

    await clickByText('4:5')
    await clickByText('生成扩图')

    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0]
    expect(req.editPrompt).toContain('4:5 canvas')
    expect(req.editPrompt).toContain('Do not crop, zoom or move')
    expect(req.imageDataUrl).toContain('outpaint-4:5:upload')

    await vi.waitFor(() => expect(container.querySelector('.tool-row-second')).toBeNull())
    expect(canvasProps.images.length).toBeGreaterThan(1)
    const last = canvasProps.images.at(-1) as unknown as { bitmap: { __tag?: string } }
    expect(last.bitmap.__tag).not.toBe('upload')
  })
})

describe('★ 超清放大：本机 2 倍、记进当前这一版的账本', () => {
  it('1200×800 → 2400×1600，成功后换底图并收工具', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const crop = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => {
      crop.click()
      await new Promise(r => setTimeout(r, 30))
    })
    await clickByText('超清放大')

    await vi.waitFor(() => expect(upscaleMod.upscaleToBitmap).toHaveBeenCalledTimes(1))
    const call = vi.mocked(upscaleMod.upscaleToBitmap).mock.calls[0]!
    expect(call[1]).toBe(2400)
    expect(call[2]).toBe(1600)
    await vi.waitFor(() => expect(container.querySelector('.tool-row-second')).toBeNull())
    const last = canvasProps.images.at(-1) as unknown as { bitmap: { __tag?: string } }
    expect(last.bitmap.__tag).toBe('upscaled')
  })

  it('选 4× 后按 12 MP 本机上限给出目标尺寸', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const crop = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    await act(async () => {
      crop.click()
      await new Promise(r => setTimeout(r, 30))
    })
    await clickByText('4×')
    await clickByText('超清放大')

    const expected = upscaleMod.upscaleTarget(
      1200, 800, { maxSide: 8192, maxArea: null }, 4,
    )!
    await vi.waitFor(() => expect(upscaleMod.upscaleToBitmap).toHaveBeenCalledTimes(1))
    const call = vi.mocked(upscaleMod.upscaleToBitmap).mock.calls[0]!
    expect(call[1]).toBe(expected.width)
    expect(call[2]).toBe(expected.height)
  })
})

describe('★ 涂鸦：装饰工具里的第四种模式', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().doodle as {
    strokes: unknown[]
    color: string
    sizePct: number
    opacity: number
    onStroke: (stroke: {
      points: { x: number; y: number }[]
      color: string
      sizePct: number
      opacity: number
    }) => void
  } | null
  const applyButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '应用涂鸦') as HTMLButtonElement

  it('★ 装饰 → 涂鸦 → 画一笔 → 撤销 / 再画 → 应用后换底图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('[aria-label="装饰"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('涂鸦')
    expect(container.querySelector('.tool-row-second'), '开着涂鸦时第二行该在').toBeTruthy()
    expect(applyButton().disabled, '还没画时不许应用').toBe(true)

    const stroke = {
      points: [{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 }],
      color: '#ff4d4d', sizePct: 4, opacity: 80,
    }
    await act(async () => {
      sceneOf()!.onStroke(stroke)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(sceneOf()!.strokes).toHaveLength(1)
    expect(applyButton().disabled).toBe(false)

    await clickByText('撤销一笔')
    expect(sceneOf()!.strokes).toHaveLength(0)
    expect(applyButton().disabled).toBe(true)

    await act(async () => {
      sceneOf()!.onStroke(stroke)
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      applyButton().click()
      await new Promise(r => setTimeout(r, 30))
    })
    expect(vi.mocked(doodleMod.doodleToBitmap)).toHaveBeenCalledTimes(1)
    const [src, strokes] = vi.mocked(doodleMod.doodleToBitmap).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(strokes).toHaveLength(1)
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'doodle' } })
    expect(last().params).toEqual(ZERO)
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })
})

describe('★ 光效：装饰工具里的第五种模式', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().light as {
    options: { preset: string; intensity: number; angle?: number; warmth?: number }
  } | null

  async function setLightSlider(label: string, value: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === label) as HTMLElement
    expect(row, `滑杆「${label}」应该在`).toBeTruthy()
    await act(async () => {
      ;(row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const input = row.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('装饰 → 光效 → 漏光 → 应用后换底图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('[aria-label="装饰"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('光效')
    expect(sceneOf()?.options).toMatchObject({ preset: 'sun', intensity: 60 })
    await clickByText('漏光')
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === '强度')!
    await act(async () => {
      ;(row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const input = row.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '80')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => {
      await clickByText('应用光效')
      await new Promise(r => setTimeout(r, 30))
    })
    expect(vi.mocked(lightMod.lightToBitmap)).toHaveBeenCalledTimes(1)
    const [src, opts] = vi.mocked(lightMod.lightToBitmap).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(opts).toMatchObject({ preset: 'leak', intensity: 80 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'lighted' } })
    expect(last().params).toEqual(ZERO)
  })

  it('方向光：光源方向和冷暖进入引擎', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('[aria-label="装饰"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('光效')
    await clickByText('方向光')
    expect(sceneOf()?.options).toMatchObject({
      preset: 'relight', intensity: 60, angle: 315, warmth: 0,
    })
    await setLightSlider('光源方向', 90)
    await setLightSlider('冷暖', 60)
    await act(async () => {
      await clickByText('应用光效')
      await new Promise(r => setTimeout(r, 30))
    })
    const [, opts] = vi.mocked(lightMod.lightToBitmap).mock.calls.at(-1)!
    expect(opts).toMatchObject({
      preset: 'relight', intensity: 60, angle: 90, warmth: 60,
    })
  })
})

describe('★ 双色调：装饰工具里的第六种模式', () => {
  const last = () => canvasProps.props.at(-1)!
  const sceneOf = () => last().duotone as {
    options: { shadow: string; highlight: string; intensity: number }
  } | null

  it('装饰 → 双色调 → 紫夜 → 应用后换底图', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('[aria-label="装饰"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('双色调')
    expect(sceneOf()?.options).toMatchObject({
      shadow: '#0b1f2a', highlight: '#e8d7b8', intensity: 70,
    })
    await clickByText('紫夜')
    expect(sceneOf()?.options).toMatchObject({
      shadow: '#160b2e', highlight: '#f0c8ff',
    })
    await act(async () => {
      await clickByText('应用双色调')
      await new Promise(r => setTimeout(r, 30))
    })
    expect(vi.mocked(duotoneMod.duotoneToBitmap)).toHaveBeenCalledTimes(1)
    const [src, opts] = vi.mocked(duotoneMod.duotoneToBitmap).mock.calls[0]!
    expect(src).toMatchObject({ __tag: 'upload' })
    expect(opts).toMatchObject({
      shadow: '#160b2e', highlight: '#f0c8ff', intensity: 70,
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'duotone' } })
    expect(last().params).toEqual(ZERO)
    expect(last().duotone).toBeNull()
  })
})

describe('★ 自定义图片贴纸', () => {
  it('选自己的透明图 → 预览 → 存成可恢复的 PNG data URL', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    const cell = container.querySelector('[aria-label="装饰"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('贴纸')

    const input = container.querySelector('.tool-row-second input[type="file"]') as HTMLInputElement
    expect(input, '自定义贴纸要有一个图片选择器').toBeTruthy()
    expect(input.accept).toContain('.heic')
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(fakeDecoded('custom-sticker'))
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'my-sticker.png', { type: 'image/png' })],
      configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(canvasProps.props.at(-1)?.sticker).toMatchObject({
      options: { source: 'image', sizePct: 18 },
      customPreview: 'data:image/png;base64,U1RJQ0tFUg==',
    })
    await clickByText('应用贴纸')
    const layers = canvasProps.props.at(-1)?.layers as {
      kind: string; options: Record<string, unknown>; image?: string | null
    }[]
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({
      kind: 'sticker',
      options: { source: 'image', x: 0.5, y: 0.5, sizePct: 18 },
      image: 'data:image/png;base64,U1RJQ0tFUg==',
    })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'upload' } })
  })
})

describe('★ 双重曝光：装饰工具里的第三种模式', () => {
  async function setToolSlider(label: string, value: number) {
    const row = [...container.querySelectorAll('.tool-row-second .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === label)!
    expect(row, `第二行该有「${label}」`).toBeTruthy()
    await act(async () => {
      ;(row.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const input = row.querySelector('input.slider-edit') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 选第二张图 → 正片叠底 70% → 应用叠加换底图', async () => {
    await renderApp()
    await uploadPhoto()
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce(fakeDecoded('overlay'))
    await goNav('调色')
    await act(async () => {
      ;(container.querySelector('[aria-label="装饰"]') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('叠加')
    const input = container.querySelector('.tool-row-second input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const file = new File(['x'], 'overlay.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    await clickByText('正片叠底')
    await setToolSlider('不透明度', 70)
    expect(canvasProps.props.at(-1)?.doubleExposure).toMatchObject({
      mode: 'multiply', opacity: 70,
    })
    await clickByText('应用叠加')

    const [base, overlay, opts] = vi.mocked(doubleMod.doubleExposureToBitmap).mock.calls[0]!
    expect(base).toMatchObject({ __tag: 'upload' })
    expect(overlay).toMatchObject({ __tag: 'overlay' })
    expect(opts).toEqual({ mode: 'multiply', opacity: 70 })
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'double' } })
    expect(canvasProps.props.at(-1)?.doubleExposure).toBeNull()
    expect(container.querySelector('.tool-row-second')).toBeNull()
  })
})

describe('★ 调色剪贴板：复制 / 粘贴一套调色', () => {
  it('复制后重置，再粘贴能把参数原样带回来', async () => {
    localStorage.clear()
    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30, temperature: 12 }, reply: '亮一点、暖一点。' }),
    )
    await say('亮一点暖一点')
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(30)
    expect(canvasProps.props.at(-1)?.params.temperature).toBe(12)
    await goNav('调色')

    const paste = () => [...container.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === '粘贴调色') as HTMLButtonElement
    expect(paste().disabled, '还没复制时不能粘贴').toBe(true)
    await clickByText('复制调色')
    expect(paste().disabled).toBe(false)
    expect(localStorage.getItem('pinkrose.adjustments.clipboard')).toContain('"exposure":30')

    await clickByText('重置')
    expect(canvasProps.props.at(-1)?.params).toEqual(ZERO)
    await clickByText('粘贴调色')
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(30)
    expect(canvasProps.props.at(-1)?.params.temperature).toBe(12)
  })
})

describe('★ 照片信息：按需读取，不挡修图', () => {
  it('展开后显示文件与尺寸；没有 EXIF 时说清楚', async () => {
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await clickByText('照片信息')
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    const info = container.querySelector('.photo-info')
    expect(info, '照片信息块该展开').toBeTruthy()
    expect(info?.textContent).toContain('文件大小')
    expect(info?.textContent).toContain('尺寸')
    expect(info?.textContent).toContain('不会上传')
    expect(info?.textContent).toContain('没有可读的拍摄信息')
  })
})

describe('★ 一键 AI 动作', () => {
  it('加号 → 修复老照片：固定提示词走生成，成功后推一个新版本', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await act(async () => {
      ;(container.querySelector('.chat-plus') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('修复老照片')
    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0] as { editPrompt: string }
    expect(req.editPrompt).toContain('Restore this old photograph')
    expect(req.editPrompt).toContain('facial identity')
    await vi.waitFor(() => expect(container.querySelectorAll('.strip-node')).toHaveLength(2))
  })

  it('AI 动作十五颗都在；动漫化送 anime 提示词并推新版本', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await act(async () => {
      ;(container.querySelector('.chat-plus') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    for (const label of [
      '修复老照片', '画质增强', '黑白上色', '消除路人', '换天空', '动漫化', '手绘化',
      'AI 写真', 'AI 换装', '去水印', 'AI 发型',
      '海边背景', '城市夜景', '雪景', '商品白底',
    ]) {
      expect([...container.querySelectorAll('.chat-tool')]
        .some(el => (el.textContent ?? '').includes(label)), label).toBe(true)
    }
    await clickByText('动漫化')
    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0] as { editPrompt: string }
    expect(req.editPrompt).toContain('anime illustration')
    await vi.waitFor(() => expect(container.querySelectorAll('.strip-node')).toHaveLength(2))
  })

  it('画质增强：固定提示词只增强清晰度与噪点，不重画人物', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await act(async () => {
      ;(container.querySelector('.chat-plus') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('画质增强')
    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0] as { editPrompt: string }
    expect(req.editPrompt).toContain('Enhance image quality')
    expect(req.editPrompt).toContain('facial identity')
    await vi.waitFor(() => expect(container.querySelectorAll('.strip-node')).toHaveLength(2))
  })

  it('消除路人：固定提示词保留主体、清理背景人物，并推一个新版本', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await act(async () => {
      ;(container.querySelector('.chat-plus') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('消除路人')
    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0] as { editPrompt: string }
    expect(req.editPrompt).toContain('incidental people')
    expect(req.editPrompt).toContain('main subject')
    expect(req.editPrompt).toContain('do not add any new people')
    await vi.waitFor(() => expect(container.querySelectorAll('.strip-node')).toHaveLength(2))
  })

  it('换天空：固定提示词只替换天空、保住前景，并推一个新版本', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await act(async () => {
      ;(container.querySelector('.chat-plus') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await clickByText('换天空')
    await vi.waitFor(() => expect(api.postEdit).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.postEdit).mock.calls[0]![0] as { editPrompt: string }
    expect(req.editPrompt).toContain('Replace only the sky')
    expect(req.editPrompt).toContain('foreground')
    expect(req.editPrompt).toContain('no text, no watermark')
    await vi.waitFor(() => expect(container.querySelectorAll('.strip-node')).toHaveLength(2))
  })
})
