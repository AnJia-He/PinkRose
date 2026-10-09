// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **工具那一簇**：裁剪 / 点修 / 对比 / 按住看原图 / 图上点选。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import { OK, bodyOf, canvasProps, clickByText, container, decision, decodedBitmaps, fakeBitmap, fakeDecoded, fetchMock, goNav, lastReply, makeGate, makeSession, renderApp, reopenApp, say, uploadPhoto, waitPersist, withSessions } from './test/appHarness'
import { act } from 'react'
import * as decodeMod from './image/decode'
import * as api from './api/client'
import * as thumbMod from './core/thumbnail'
import * as cropMod from './image/crop'
import * as eraseMod from './image/erase'
import { stampBrush } from './core/retouch'
import { describe, expect, it, vi } from 'vitest'
import type { SuggestResponse } from './test/appHarness'

describe('★ 裁剪：框 + 第二行 + 完成 = 给当前这一版记一笔账（不加转盘格）', () => {
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
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    expect(body.base, '裁剪之后那一趟必须重新带上底图').toBeTruthy()
    expect(body.thumb, '封面也要跟着换（左栏列表上显示的是"最后那张"）').toBeTruthy()
    expect((body.steps as { label: string }[]).map(s => s.label)).toEqual(['原图'])
  })

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

describe('★ 点修：涂抹层 + 第二行 + 擦掉这里 = 给当前这一版记一笔账（不加转盘格）', () => {
  const last = () => canvasProps.props.at(-1)!
  /** 交给画布的点修现场（App 算好那一整块）。 */
  const sceneOf = () => last().retouch as {
    radius: number; mode: 'paint' | 'erase'; mask: Uint8Array; onMaskChange: () => void
  } | null
  const putCalls = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === 'PUT')
  const eraseButton = () => [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '擦掉这里') as HTMLButtonElement

  /** 进点修：先去调色屏，再点工具行那颗「点修」。 */
  async function openRetouch() {
    await goNav('调色')
    const cell = container.querySelector('[aria-label="点修"]') as HTMLButtonElement
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
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
