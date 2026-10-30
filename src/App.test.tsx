// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **核心那条路**：说话改图、生成的花费、导出、时间轴小图。
 *
 * ★ 2026-10-09：原来这一个文件 9421 行（全库 19%），拆成**六个**：
 *   `App.test`（这一份，核心）/ `App.tools` / `App.account` / `App.gallery` /
 *   `App.sessions` / `App.adjust`，脚手架（那堆 `vi.mock` + 造数据的工厂 +
 *   `beforeEach`）在 `test/appHarness.tsx`。
 *   ⚠️ **源码注释里那些"`App.test.tsx` 里有一条钉着…"说的就是这一族** ——
 *   拿那句断言的原文在 `src/App.*.test.tsx` 里搜，就在某一个文件里。
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import { OK, bodyOf, canvasProps, clickByText, container, cropOnce, decision, fakeBitmap, fakeDecoded, fetchMock, goNav, jsonResponse, lastReply, makeGate, openChatTool, putCalls, renderApp, say, setMeUser, uploadFiles, uploadPhoto, waitPersist, withPresets } from './test/appHarness'
import { act } from 'react'
import { clampAdjustments, ZERO } from '../shared/adjustments.ts'
import { type PresetMeta } from '../shared/preset.ts'
import * as decodeMod from './image/decode'
import * as api from './api/client'
import * as limitsMod from './render/limits'
import * as resizeMod from './image/resize'
import * as saveMod from './export/save'
import { EXPORT_DEFAULTS_KEY } from './export/prefs'
import { describe, expect, it, vi } from 'vitest'
import type { RouteDecision } from './test/appHarness'

describe('对话式修图：钱花在对的地方', () => {
  it('文件选择器明确接受 iPhone 的 HEIC / HEIF，而不是只靠 image/* 猜', async () => {
    await renderApp()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept).toContain('.heic')
    expect(input.accept).toContain('.heif')
  })

  it('★ RAW 走相机内嵌 JPEG 预览时，明确说明不是完整 RAW 解档', async () => {
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce({
      ...fakeDecoded('raw-preview'),
      rawPreview: { width: 1600, height: 1067 },
    })
    await renderApp()
    await uploadPhoto()
    const text = container.textContent ?? ''
    expect(text).toContain('相机内嵌的 JPEG 预览')
    expect(text).toContain('1600×1067')
    expect(text).toContain('不是完整 RAW 解档')
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'raw-preview' } })
  })

  it('★ Display P3 源照片会明确说明当前编辑链转为 sRGB', async () => {
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValueOnce({
      ...fakeDecoded('p3'),
      sourceColorProfile: 'display-p3',
    })
    await renderApp()
    await uploadPhoto()
    const text = container.textContent ?? ''
    expect(text).toContain('源色彩是 Display P3')
    expect(text).toContain('编辑和导出先统一转成 sRGB')
    expect(text).toContain('不会伪装成广色域编辑')
  })

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

  /**
   * ★ 2026-10-10：「停止」只在**真管用**的那一段出现。
   *
   * 那格原来在 4 种忙态里都摆「停止」，但 abort 只挂在生成那一段 ——
   * 「正在思考…」里按下它**没反应也没反馈**，像按键坏了。
   * 现在：只有生成中是「停止」；别的忙态是**禁用的「发送」**——
   * 点不动比"点了没反应"诚实，而那几段本来就短，没人会真的想取消。
   */
  it('★（10-10）「正在思考…」时那格是禁用的「发送」，不是点了没反应的「停止」', async () => {
    // 路由那一步**挂住不回**（那 1.3~1.6 秒的样子）。
    // ⚠️ 必须是 `Once`：持久的 `mockImplementation` 会**泄漏给后面的测试**
    //    （clearAllMocks 只清记录、不恢复实现）—— 后面的用例再 `say()`
    //    就会永远卡在这个"永不返回"上，症状是"助手一句话都不说"。
    vi.mocked(api.postRoute).mockImplementationOnce(() => new Promise(() => {}))
    await renderApp()
    await uploadPhoto()

    const cell = () => container.querySelector('.chat-input button:not(.chat-plus)') as HTMLButtonElement
    expect(cell().textContent).toBe('发送')
    expect(cell().disabled).toBe(false)

    await say('把后面那个人去掉')            // busy = 「正在思考…」

    expect(container.querySelector('.bubble.pending')?.textContent).toContain('正在思考')
    expect(cell().textContent).toBe('发送')   // 不是「停止」——那一段按下它什么都停不了
    expect(cell().disabled).toBe(true)        // 而是**点不动**（灰的）
  })

  /**
   * ★ 2026-10-10：等待段显示**真实经过的秒数**。
   *
   * 之前这里写死一句「大约 10 秒」，而实测生成要 8~21 秒 —— 过了 10 秒
   * 那句话就开始骗人，用户以为卡死。现在 5 秒之后换成"已经等了 N 秒"：
   * 秒数每秒在跳，本身就是"它还活着"的信号。
   *
   * ⚠️ 这条**真的等 5 秒多** —— 这个文件从头到尾用真定时器（见 appHarness 里
   *    `waitPersist` 那段：假定时器会把 act 微任务和"挂住不回"的门一起冻上）。
   *    就这一条：纯函数单测（`useGeneration.test.ts`）守不住**接没接上**。
   */
  it('★（10-10）等待超过 5 秒：忙气泡换成真实秒数', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉路人' }))
    // ⚠️ 同上必须是 `Once`（持久实现会泄漏给后面的用例）。
    vi.mocked(api.postEdit).mockImplementationOnce(() => new Promise(() => {}))   // 永远不回

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const pending = () => container.querySelector('.bubble.pending')?.textContent ?? ''
    expect(pending()).toContain('大约 10 秒')     // 一开始还是那句预期

    // 真等过 5 秒的坎（秒表 1 秒跳一次，第 5 跳 = 5 秒）
    await act(async () => { await new Promise(r => setTimeout(r, 5200)) })

    expect(pending()).toContain('已经等了')
    expect(pending()).not.toContain('大约 10 秒')  // 两个时间不能同屏
  }, 15_000)

  /**
   * ★ 2026-10-10（degraded 第一次被前端消费）：模型这次没老实给决策
   * （路由失败兜底 / 我们修正过），而这个决策要去**花钱生成** —— 回复里
   * 要说清"这次拿不太准"，不对的话用户知道换个说法（而不是怀疑自己没说清）。
   */
  it('★（10-10）degraded 的生成：回复里带上「拿不太准」的提醒', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '我直接按你说的试了一下。', degraded: true }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(lastReply()).toContain('我直接按你说的试了一下。')   // 原句还在
    expect(lastReply()).toContain('拿不太准')                  // 提醒也在
  })

  it('（10-10）正常决策（degraded: false）：一个字都不多嘴', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(lastReply()).toBe('好，这就去改。')
  })

  it('（10-10）纯参数路即使 degraded 也不提醒 —— 免费可逆，不值当报警', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '好，亮一点。', degraded: true }))

    await renderApp()
    await uploadPhoto()
    await say('亮一点')

    expect(lastReply()).toBe('好，亮一点。')
    expect(api.postEdit).not.toHaveBeenCalled()
  })

  /**
   * ★ 2026-10-10：生成失败后**一键重试** —— 不用重新打字。
   *
   * 最痛的挫败是"等了半天、花了钱、失败了还要重说一遍"，而修复几乎白送：
   * 额度已自动退还（server/app.ts 的退款），当初那句 editPrompt 就在失败现场里
   * —— 重试用它原样重跑，不重新路由（少花一次路由的钱，也少等 1.5 秒）。
   */
  it('★（10-10）生成失败：失败消息上有一颗「再试一次」，点了用同一句话重跑', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockRejectedValueOnce(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const retryBtn = () => [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '再试一次')
    expect(retryBtn()).toBeTruthy()          // ① 失败消息上挂着它

    // 这一次成功
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await clickByText('再试一次')

    expect(api.postEdit).toHaveBeenCalledTimes(2)                                   // ② 真的又跑了一次
    expect(vi.mocked(api.postEdit).mock.calls[1][0].editPrompt).toBe('去掉后面的路人') //    还是同一句话
    expect(lastReply()).toBe('好，这就去改。')                                        // ③ 成功了才说当初那句应答
    expect(retryBtn()).toBeUndefined()                                              // ④ 点过就作废（按钮收掉）
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)               // 新那一版真的落地了
  })

  it('★（10-10）失败后画面变了再点重试：说清没重试、钱一分不花', async () => {
    // 第一版成功（转盘上两格）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先把后面那个人去掉')     // 成功 → step1

    // 第二句失败
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '天空换成黄昏' }))
    vi.mocked(api.postEdit).mockRejectedValueOnce(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))
    await say('天空换成黄昏')

    // 用户跳回原图 —— 画面变了
    await act(async () => {
      ;(container.querySelector('.strip-node') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    await clickByText('再试一次')

    expect(api.postEdit).toHaveBeenCalledTimes(2)     // 没有第三次：拦住了
    expect(container.textContent).toContain('画面已经变了')
  })

  it('（10-10）「停止」不算失败：不出现「再试一次」', async () => {
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

    expect(lastReply()).toBe('停了。')
    expect([...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '再试一次')).toBeUndefined()
  })

  /**
   * ★ 2026-10-11（设计跟进 T3）：**路由失败**也挂「再试一次」—— 10-10 那批
   * 「失败一键重试」唯一没收尾的一截。
   *
   * 路由失败（你说的那句话还没被理解）原来只有一句 `say(...)`：字里说着
   * "再试一次？"而**失败气泡下没有按钮** —— 用户要么原样重打一遍，要么就卡在
   * 那儿。生成失败那半 10-10 就做好了（上面三条），这一半补上同款形状：
   * 复用同一颗 `.bubble-retry`。点它 = **把那句话原样再说一遍**（等价于用户
   * 重新打一遍再发送），成功之后照正常流程走（`postRoute` → `applyDecision`）。
   */
  it('★（10-11）路由失败：失败气泡下有「再试一次」，点了用同一句话重发（第二次成功 → 正常走下去）', async () => {
    // 第一句：路由那一趟就失败了（1.3~1.6 秒白等，只回一句"出了点问题"）
    vi.mocked(api.postRoute).mockRejectedValueOnce(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const retryBtn = () => [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '再试一次')
    expect(retryBtn()).toBeTruthy()                    // ① 失败气泡下挂着它

    // 这一次路由成功 → 生成真的跑、新那一版真的落地（"照正常流程走"整条链）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人', reply: '好，这就去改。' }))
    vi.mocked(api.postEdit).mockResolvedValueOnce(OK)
    await clickByText('再试一次')

    expect(api.postRoute).toHaveBeenCalledTimes(2)     // ② 真的又路由了一次
    const first = vi.mocked(api.postRoute).mock.calls[0][0] as { text: string }
    const again = vi.mocked(api.postRoute).mock.calls[1][0] as { text: string }
    expect(again.text).toBe(first.text)                //    送上去的还是同一句话
    expect(again.text).toBe('把后面那个人去掉')
    expect(api.postEdit).toHaveBeenCalledTimes(1)      // ③ 成功路径照走
    expect(lastReply()).toBe('好，这就去改。')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(retryBtn()).toBeUndefined()                 // ④ 点过就作废（按钮收掉）
  })

  it('★（10-11）路由失败后画面变了再点重试：不动它、说清为什么（照生成重试那两把尺子）', async () => {
    vi.mocked(api.postRoute).mockRejectedValueOnce(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    expect(api.postRoute).toHaveBeenCalledTimes(1)

    // 用户裁了一刀（= 换了一版底图），再回头点那颗「再试一次」——
    // 那句话说的是**当初那张画面**，不再成立（和生成那颗同一副判据）
    await goNav('调色')
    await cropOnce()
    await goNav('修图')                                // 调色那一屏没有对话栏

    await clickByText('再试一次')

    expect(api.postRoute).toHaveBeenCalledTimes(1)     // 没有第二次：拦住了，钱一分不花
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('画面已经变了')
    expect([...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '再试一次')).toBeUndefined()   // 点一次算一次
  })

  it('★（10-11）上传后立刻说话、建会话这时才回来 → 重试照常重发（不许拿"画面已经变了"的假话打发）', async () => {
    // 和上面那道闸的**另一半**（同 `send` 里返回时那道闸的 `sidAt !== null` 一格）：
    // 出发时 `sidAt === null`（建会话还在半路），失败之后建会话才回来 —— 那是
    // **同一条会话在长出来**，不是"人走了"。现场那一格要是照比，用户会拿到一句
    // **假话**，而且这句话永远重试不了。
    const sessionGate = makeGate<{ id: number }>()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(await sessionGate.promise)
      }
      return inner(url, init)
    })
    vi.mocked(api.postRoute).mockRejectedValueOnce(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()                        // 照片进来；建会话被挂住（sessionId 还是 null）
    await say('亮一点')                         // 立刻说话：出发时 sidAt === null；路由失败

    // 建会话在这之后才回来：`sessionIdRef` 从 null 拨成 id
    await act(async () => {
      sessionGate.open({ id: 1 })
      await new Promise(r => setTimeout(r, 0))
    })

    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await clickByText('再试一次')

    expect(api.postRoute).toHaveBeenCalledTimes(2)     // 重发真的送出去了
    expect(container.textContent).not.toContain('画面已经变了')
    expect(lastReply()).toBe('给你提亮了。')            // 成功路径照走
  })

  /**
   * ★（10-10）「帮我想想」—— 建议卡过期（10 秒）或者用掉之后，还能主动再要一批。
   * 原来上传后只出这一次：过了十秒那一块就永远空着（接口 `/api/suggest` 是现成的，
   * 缺的只是"再问一次"的入口）。入口住进加号工具行 —— 以后加工具就往那一行排。
   */
  it('★（10-10）「帮我想想」：建议卡过期之后还能再要一批', async () => {
    vi.mocked(api.postSuggest).mockResolvedValueOnce({
      cards: [{ label: '亮一点', route: 'params', paramDeltas: { exposure: 20 }, editPrompt: '' }],
      degraded: false,
    })
    await renderApp()
    await uploadPhoto()
    expect(container.querySelectorAll('.card').length).toBe(1)     // 第一批自己来了

    vi.mocked(api.postSuggest).mockResolvedValueOnce({
      cards: [{ label: '加点暖色', route: 'params', paramDeltas: { exposure: -20 }, editPrompt: '' }],
      degraded: false,
    })
    await openChatTool('帮我想想')                                  // 展开加号、点它

    expect(api.postSuggest).toHaveBeenCalledTimes(2)               // 真的去再要了一批
    expect(container.textContent).toContain('加点暖色')            // 新一批上屏了
  })

  /**
   * ★（10-10）把另一张照片**拖进页面** = 换一张改（和顶栏「新的一张」同一件事，
   * 只是省两次点击）。⚠️ 拖放的浏览器默认行为是**直接打开那个文件**（页面跳走、
   * 手上没落盘的改动全没）—— 所以 dragover / drop 必须 preventDefault。
   */
  it('★（10-10）拖一张图进来 = 换一张改（对话跟着清空重来）', async () => {
    // 自给自足（不靠 beforeEach 的默认 mock）：这条要 `say()` 一句，
    // 而 mock 的状态是**跨用例共享**的（clearAllMocks 不恢复实现）。
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '好，亮一点。' }))
    await renderApp()
    await uploadPhoto()
    await say('亮一点')
    expect(container.querySelectorAll('.bubble.assistant:not(.pending)').length).toBe(2)

    await act(async () => {
      dispatchDrop(new File(['x'], 'b.png', { type: 'image/png' }))
      await new Promise(r => setTimeout(r, 0))
    })

    // 第二张真的被解码了（走的是和"选一张"同一条路：onPick）
    expect(decodeMod.decodeImageFile).toHaveBeenCalledTimes(2)
    // 换了一张 = 对话清空重来（只剩新的那条欢迎语）
    expect(container.querySelectorAll('.bubble.assistant:not(.pending)').length).toBe(1)
    expect(lastReply()).toBe('准备好啦，说说想怎么改？')
  })

  it('★（10-10）粘贴一张图，同样是换一张改', async () => {
    await renderApp()
    await uploadPhoto()

    await act(async () => {
      dispatchPaste(new File(['x'], 'c.png', { type: 'image/png' }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(decodeMod.decodeImageFile).toHaveBeenCalledTimes(2)
  })

  it('★ 编辑中一次拖入多张 = 全部送进批量处理，后面的照片不被吞掉', async () => {
    await renderApp()
    await uploadPhoto()
    const a = new File(['a'], '拖入-a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], '拖入-b.jpg', { type: 'image/jpeg' })
    const notes = new File(['x'], '说明.txt', { type: 'text/plain' })

    await act(async () => {
      dispatchDrop([a, notes, b])
      await new Promise(r => setTimeout(r, 0))
    })

    expect(location.pathname).toBe('/app/works')
    await vi.waitFor(
      () => expect(container.querySelector('.batch-page')).toBeTruthy(),
      { timeout: 10_000 },
    )
    await vi.waitFor(() => {
      expect(container.textContent).toContain('拖入-a.jpg')
      expect(container.textContent).toContain('拖入-b.jpg')
      expect(container.textContent).toContain('2 / 20')
      expect(container.textContent).not.toContain('说明.txt')
    }, { timeout: 10_000 })
    // 批量页收齐文件后再解码；拖放入口本身不该只把第一张当单图打开。
    expect(decodeMod.decodeImageFile).toHaveBeenCalledTimes(1)
  })

  it('★ 单张照片配同名 XMP：作为这张照片的初始调色，优先于默认风格', async () => {
    await renderApp()
    const sidecar = new File([
      `<?xpacket?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:PresetName="导入配方"
            crs:Exposure2012="1.5" />
        </rdf:RDF>
      </x:xmpmeta>`,
    ], 'p.xmp', { type: 'application/rdf+xml' })
    Object.defineProperty(sidecar, 'text', {
      value: async () => [
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
        '<rdf:Description rdf:about=""',
        ' xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
        ' crs:PresetName="导入配方" crs:Exposure2012="1.5" />',
        '</rdf:RDF></x:xmpmeta>',
      ].join(''),
    })
    await uploadPhoto([sidecar])

    await vi.waitFor(() => {
      expect(container.textContent).toContain('已套用同名 XMP 调色旁车「导入配方」')
    })
    await goNav('调色')
    const exposure = [...container.querySelectorAll('.panel label.slider')]
      .find(label => label.querySelector('.slider-label')?.textContent?.trim() === '亮度')
    expect(exposure?.querySelector('.slider-value')?.textContent?.trim()).toBe('30')
  })

  it('★ 多张照片各带同名 XMP：全部进入批量并逐张配对旁车', async () => {
    await renderApp()
    const a = new File(['a'], 'a.CR3', { type: '' })
    const b = new File(['b'], 'b.JPG', { type: 'image/jpeg' })
    const ax = new File(['ax'], 'a.xmp', { type: 'application/rdf+xml' })
    const bx = new File(['bx'], 'b.xmp', { type: 'application/rdf+xml' })
    await uploadFiles([a, ax, b, bx])

    await vi.waitFor(
      () => expect(container.querySelector('.batch-page')).toBeTruthy(),
      { timeout: 10_000 },
    )
    await vi.waitFor(() => {
      expect(container.textContent).toContain('已匹配 2 份同名 XMP')
      expect(container.textContent).not.toContain('a.xmp')
    }, { timeout: 10_000 })
  })

  it('（10-10）还没有照片时不接拖放 —— 那一屏是欢迎页自己的地盘', async () => {
    await renderApp()
    await act(async () => {
      dispatchDrop(new File(['x'], 'b.png', { type: 'image/png' }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(decodeMod.decodeImageFile).not.toHaveBeenCalled()
  })
})

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

describe('导出：分享还是存下来，用户自己选', () => {
  /** 顶栏现在的按钮，从左到右。 */
  function topbarButtons(): string[] {
    // 只数**顶栏这一排**的直接按钮；导出设置弹层里的「设为默认」住在
    // `.actions` 里面的 `<details>` 里，不是这一排的动作。
    return [...container.querySelectorAll('.actions > button')].map(b => b.textContent ?? '')
  }

  function topbar(label: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('.actions > button')]
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

  it('★ 自定义文件名：下载用用户填的名字，扩展名跟当前格式走', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    const input = container.querySelector('input[name="export-filename"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '海边的日落')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('下载')
    expect(vi.mocked(saveMod.downloadImage).mock.calls[0][1]).toBe('海边的日落.jpg')
  })

  it('★ 导出设置：WebP + 质量 80 → 下载的就是这套编码，文件名跟着换后缀', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()

    const webp = container.querySelector(
      'input[name="export-format"][value="image/webp"]') as HTMLInputElement
    expect(webp, '导出设置里该有 WebP').toBeTruthy()
    await act(async () => { webp.click() })

    const quality = container.querySelector('input[name="export-quality"]') as HTMLInputElement
    expect(quality, 'JPG / WebP 该有质量滑块').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(quality, '80')
      quality.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await click('下载')

    expect(vi.mocked(saveMod.buildExportBlob)).toHaveBeenCalledTimes(1)
    const call = vi.mocked(saveMod.buildExportBlob).mock.calls[0]
    expect(call[2]).toBe('image/webp')
    expect(call[3]).toBeCloseTo(0.8, 6)
    expect(vi.mocked(saveMod.downloadImage).mock.calls[0][1]).toBe('p_pinkrose.webp')
  })

  it('★ 导出设置：关掉「保留拍摄信息」→ 导出引擎收到 false', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()

    const keep = container.querySelector('input[name="export-metadata"]') as HTMLInputElement
    expect(keep, '导出设置里该有「保留拍摄信息」').toBeTruthy()
    expect(keep.checked).toBe(true)
    await act(async () => { keep.click() })
    await click('下载')

    expect(vi.mocked(saveMod.buildExportBlob)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveMod.buildExportBlob).mock.calls[0]![4]).toBe(false)
  })

  it('★ 只关掉 GPS：拍摄信息仍保留，位置单独传 false', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    const location = container.querySelector(
      'input[name="export-location"]') as HTMLInputElement
    expect(location).toBeTruthy()
    await act(async () => { location.click() })
    await click('下载')
    const call = vi.mocked(saveMod.buildExportBlob).mock.calls[0]!
    expect(call[4]).toBe(true)
    expect(call[6]).toBe(false)
  })

  it('★ 作者与版权进入导出引擎，留空时由引擎保留原值', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    const creator = container.querySelector('input[name="export-creator"]') as HTMLInputElement
    const copyright = container.querySelector('input[name="export-copyright"]') as HTMLInputElement
    expect(creator).toBeTruthy()
    expect(copyright).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(creator, 'Photographer A')
      creator.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(copyright, '© 2026 Photographer A')
      copyright.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('下载')
    const call = vi.mocked(saveMod.buildExportBlob).mock.calls[0]!
    expect(call[7]).toEqual({
      creator: 'Photographer A',
      copyright: '© 2026 Photographer A',
    })
  })

  it('★ 导出偏好：新照片沿用上次存下的格式 / 质量 / 尺寸 / 比例', async () => {
    localStorage.setItem(EXPORT_DEFAULTS_KEY, JSON.stringify({
      format: 'image/webp',
      qualityPct: 82,
      longEdge: 2048,
      aspect: '4:5',
      fit: 'blur',
      preserveMetadata: false,
    }))
    try {
      await renderApp()
      await uploadPhoto()

      expect((container.querySelector(
        'input[name="export-format"][value="image/webp"]') as HTMLInputElement).checked).toBe(true)
      expect((container.querySelector(
        'input[name="export-quality"]') as HTMLInputElement).value).toBe('82')
      expect((container.querySelector(
        'input[name="export-size"][value="2048"]') as HTMLInputElement).checked).toBe(true)
      expect((container.querySelector(
        'input[name="export-aspect"][value="4:5"]') as HTMLInputElement).checked).toBe(true)
      // WebP 也能保留拍摄信息；沿用上次关闭的选择时必须保持未勾选。
      const metadata = container.querySelector(
        'input[name="export-metadata"]') as HTMLInputElement
      expect(metadata).toBeTruthy()
      expect(metadata.checked).toBe(false)
      expect(container.textContent).not.toContain('当前格式不写入拍摄信息')

      const save = [...container.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '设为默认')!
      expect(save).toBeTruthy()
      await act(async () => { save.click(); await new Promise(r => setTimeout(r, 0)) })
      expect(JSON.parse(localStorage.getItem(EXPORT_DEFAULTS_KEY)!)).toMatchObject({
        format: 'image/webp', qualityPct: 82, longEdge: 2048, aspect: '4:5',
      })
      expect(container.querySelector('.notice')?.textContent ?? '')
        .toContain('以后下载和分享')
    } finally {
      localStorage.removeItem(EXPORT_DEFAULTS_KEY)
    }
  })

  it('★ 账号级导出偏好：登录后覆盖本机默认值', async () => {
    setMeUser({
      id: 1, username: '小明', email: 'a@b.com',
      preferences: {
        export: {
          format: 'image/png', qualityPct: 70, longEdge: null,
          aspect: '1:1', fit: 'crop', preserveMetadata: true,
        },
      },
    })
    localStorage.removeItem(EXPORT_DEFAULTS_KEY)
    await renderApp()
    await uploadPhoto()

    expect((container.querySelector(
      'input[name="export-format"][value="image/png"]') as HTMLInputElement).checked).toBe(true)
    expect((container.querySelector(
      'input[name="export-aspect"][value="1:1"]') as HTMLInputElement).checked).toBe(true)
    expect(container.querySelector('input[name="export-quality"]')).toBeNull()
  })

  it('★ 保存导出默认值不会冲掉账号里的默认风格（同一份 preferences 合并）', async () => {
    setMeUser({
      id: 1, username: '小明', email: 'a@b.com',
      preferences: { style: 'portrait' },
    })
    await renderApp()
    await uploadPhoto()

    const save = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '设为默认')
    expect(save, '导出设置里该有「设为默认」').toBeTruthy()
    await act(async () => { save!.click(); await new Promise(r => setTimeout(r, 0)) })

    const patch = fetchMock.mock.calls.find(
      ([u, init]) => u === '/api/me' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patch, '应把导出默认值同步到账号').toBeTruthy()
    expect(bodyOf(patch!).preferences).toMatchObject({
      style: 'portrait',
      export: { format: 'image/jpeg' },
    })
  })

  it('★ 导出设置：水印只画在导出副本上；存进作品不带水印', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()

    const text = container.querySelector(
      'input[name="export-watermark-text"]') as HTMLInputElement
    expect(text, '导出设置里该有水印文字输入').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(text, 'PinkRose')
      text.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await click('下载')
    expect(saveMod.markExportCanvas).toHaveBeenCalledTimes(1)
    const [source, watermark, logo] = vi.mocked(saveMod.markExportCanvas).mock.calls[0]!
    expect(source).toBe(container.querySelector('.canvas-wrap canvas, canvas'))
    expect(watermark).toMatchObject({ text: 'PinkRose', kind: 'text' })
    expect(logo).toBeNull()

    await click('存进作品')
    expect(saveMod.markExportCanvas).toHaveBeenCalledTimes(1)
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
   * ★ 2026-10-09：**`img` 要去掉 AI 头像那一颗**（`.msg-avatar`）—— 用户要的
   * 「把LOGO作为ai对话的头像」是**装饰性的图标**，不是照片；判据换成
   * `img:not(.msg-avatar)`，"照片不许进对话区"这条规矩一个字没松。
   */
  it('★ 对话区里不再有照片 —— 小图只在转盘上', async () => {
    await renderApp()
    await uploadPhoto()
    const msg = container.querySelector('.msg.assistant')
    expect(msg).toBeTruthy()
    // 那条消息里：只有话。★ 2026-10-06（晚）：它连操作行都没有了 ——
    // 「你在这里」那颗位置标记退役之后，原图那条一颗按钮都不剩。
    // （那一颗 `.msg-avatar` 不算 —— 见上面 ★ 2026-10-09 那段。）
    expect(msg!.querySelector('img:not(.msg-avatar)')).toBeNull()
    expect(msg!.querySelector('.bubble-text')?.textContent).toBe('准备好啦，说说想怎么改？')
    expect(msg!.querySelector(':scope > .bubble-actions')).toBeNull()
    // 整个对话栏里一张照片都没有；小图在舞台上那圈转盘里
    expect(container.querySelector('.chat img:not(.msg-avatar)')).toBeNull()
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

    expect(thumbOf(1)).toBe('thumb:' + JSON.stringify(clampAdjustments({ ...ZERO, exposure: 40 })))
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

/** ★ 2026-10-10：往 document 上丢一个"文件被拖进来"的事件
 *  （jsdom 没有真 DataTransfer，手搓一个只有我们读的那两个字段的）。 */
function dispatchDrop(file: File | File[]) {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files: Array.isArray(file) ? file : [file], types: ['Files'] },
  })
  document.dispatchEvent(ev)
}

/** ★ 2026-10-10：往 document 上丢一个"粘贴"事件（剪贴板里是一张图）。 */
function dispatchPaste(file: File) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] },
  })
  document.dispatchEvent(ev)
}

/**
 * ★ 2026-10-10（「我的预设」，设计 §6.3）：**对话那条** —— 说「用我那套黄昏旅拍」
 * 时整套参数赋上去。
 *
 * 走真链路：`GET /api/presets` → `usePresets` → App 的 `myPresets`（`core/presets`
 * 那套形状）→ `useGeneration` 的 `applyDecision`。这一层量的是**接线**：
 * ① 清单有没有送到模型面前（它靠它认名字，不给就只能编）；
 * ② 决策回来了有没有落地；
 * ③ 落地是不是**合流进算 `nextParams` 的那一段** —— 快照（缩略图 / 「回到这一步」）
 *    读的就是它（另开一块 `setParams` 会让小图和主画面对不上，T8 那一类）。
 * 名字怎么对号（trim + 忽略大小写）在 `shared/preset.ts` 那边单测兜着。
 */
describe('★ 我的预设：对话那条（2026-10-10）', () => {
  /** 一套"带色"的参数（全零的比不出来 —— 和"什么都没做"分不开）。 */
  const MINE = { ...ZERO, exposure: 33, contrast: -21, splitHiHue: 120 }
  const PRE = (id: number, name: string, params = MINE): PresetMeta =>
    ({ id, name, params, createdAt: 0 })
  /** 时间轴上第 index 格的小图（和「历史小图」那一组同款）。 */
  const thumbOf = (index: number): string | null =>
    container.querySelectorAll<HTMLImageElement>('.strip-thumb')[index]?.getAttribute('src') ?? null
  /** 这一趟落盘那笔 PUT 的请求体（和「滤镜」「裁剪」那两组同款）。 */
  const lastPutBody = () => bodyOf(putCalls('/api/sessions/1').at(-1)!)

  it('★ 说「用我那套X」：整套参数赋上去（和手点预设栏同一条路）', async () => {
    withPresets([PRE(11, '黄昏旅拍')])
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', preset: { name: '黄昏旅拍' }, reply: '套上了。' }))

    await renderApp()
    await uploadPhoto()
    await say('用我那套黄昏旅拍')

    // ① 请求里带着清单（只给名字 + 参数）：模型就是靠它认名字的
    expect((vi.mocked(api.postRoute).mock.calls[0][0] as { presets?: unknown }).presets)
      .toEqual([{ name: '黄昏旅拍', params: MINE }])
    // ② 参数**整套**赋上去了 —— 和手点预设栏那一下同一条路（裁定 ⑤ 那一级）
    expect(canvasProps.props.at(-1)?.params).toEqual(MINE)

    // ③ 而且真的生效了：再发一句，这次请求里带的参数就是那一套
    //    （少了这一半，只能证明"画布上变了"，证明不了"后面都按它走"）
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision())
    await say('就这样')
    const second = vi.mocked(api.postRoute).mock.calls[1][0] as { params: unknown }
    expect(second.params).toEqual(MINE)
  })

  it('★ 套预设 + 生成同一次决策：**快照记的是套完之后的那套参数**（缩略图与主画面一致）', async () => {
    // 这条是本任务存在的理由（设计 §6.3）：预设赋值必须**合流**进算 `nextParams`
    // 的那一段。像 Lut 那样另开一块 `setParams` 的话，推快照时传下去的
    // `paramsAtStep` 还是决策之前那份 —— 缩略图（从新画面上抓的）和「回到这一步」
    // 还原出来的主画面就对不上（T8 修过两次的那一类）。
    withPresets([PRE(11, '黄昏旅拍')])
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({
      route: 'both', preset: { name: '黄昏旅拍' },
      editPrompt: 'remove the tourists', reply: '好了。',
    }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('用我那套黄昏旅拍，再把路人去掉')

    // 时间轴那格的缩略图 = 那一套（抓的就是画布上此刻的颜色）
    expect(thumbOf(1)).toBe('thumb:' + JSON.stringify(clampAdjustments(MINE)))
    // 主画面也是它 —— 两边同一个值，才是"缩略图与主画面一致"
    expect(canvasProps.props.at(-1)?.params).toEqual(MINE)

    // 快照**本身**记的也是它（落盘那一份 = 服务端将来恢复用的那一份）
    await waitPersist()
    expect((lastPutBody().steps.at(-1) as { params: unknown }).params).toEqual(MINE)
  })

  it('模型给的名字不在清单里：不动状态（参数一个字节没变）', async () => {
    // 服务端本该在更前面那一层把它归 null + degraded；这是第二道 ——
    // 照 Lut 那条"宁可什么都不做，也别套一个用户没有的东西"（设计 §6.4）。
    // 留痕用 spy 顺手接住：这一行 console.warn 不该是屏幕上唯一发生过的事。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      withPresets([PRE(11, '黄昏旅拍')])
      vi.mocked(api.postRoute).mockResolvedValueOnce(
        decision({ route: 'params', paramDeltas: { exposure: 20 } }))
      await renderApp()
      await uploadPhoto()
      await say('亮一点')
      expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20 })

      vi.mocked(api.postRoute).mockResolvedValueOnce(
        decision({ route: 'params', preset: { name: '没有这一套' } }))
      await say('用我那套夕阳')

      // 参数还是上一步那套，一个字节没变
      expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20 })
      // 第二道防线留了痕（"对不上号"这件事不该被悄悄咽掉）
      expect(warn.mock.calls.flat().map(String).join(' ')).toContain('没有这一套')
    } finally {
      warn.mockRestore()
    }
  })

  it('「用我那套X，再亮一点」：预设打底、增量叠上去', async () => {
    // 一条式子办两件事：`base` = 命中那一套，同一次决策的增量再叠在它上面
    // （设计 §6.3 的语义）。变异（像 Lut 那样另开一块 setParams）：后一次把
    // 前一次盖掉 —— 用户那句"再亮一点"悄悄丢了，而画面上看起来"预设套上了"。
    withPresets([PRE(11, '黄昏旅拍')])
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({
      route: 'params', preset: { name: '黄昏旅拍' }, paramDeltas: { exposure: 20 },
    }))

    await renderApp()
    await uploadPhoto()
    await say('用我那套黄昏旅拍，再亮一点')

    expect(canvasProps.props.at(-1)?.params)
      .toEqual({ ...MINE, exposure: MINE.exposure + 20 })
  })
})
