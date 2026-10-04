// @vitest-environment jsdom
/**
 * 模型设置（Task 9，spec §7.3 / §7.4 / §7.7 / §9）。
 *
 * ⚠️ 这一份**不 mock `fetch`，而是 mock `src/api/models.ts` 那一层**：这个文件要测的
 *    是"界面把哪些字段发出去、把回的话怎么显示"，请求本身怎么拼（`credentials:
 *    'same-origin'` 那些）归 `api/client.ts` 那一层自己的测试。
 *
 * ⚠️ 假服务端是一份**内存里的名单，动作之后跟着变** —— 因为界面每做完一个动作都会
 *    重新拉一次（reload）。假服务端不跟着变的话，"删掉的那一行没了吗""存完回名单
 *    了吗"都停在上一次的画面里，测了个寂寞。
 *
 * ⚠️ 这一页有一条**否定**断言当家（不许出现型号名 / 我们的地址，§7.3）。否定断言
 *    最容易假绿 —— 整页没渲染时它照样通过 —— 所以它前面先钉一句"名单真的画出来了"，
 *    另外配一条"打开编辑表单，型号名**确实**看得见"把否定断言的靶子立起来。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { UNREADABLE_KEY_HINT, type ModelKind, type PublicConfig } from '../api/models'
import { ModelSettings } from './ModelSettings'

vi.mock('../api/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/models')>()
  return {
    ...actual,
    listModels: vi.fn(),
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
    activateModel: vi.fn(),
    testModel: vi.fn(),
  }
})

import * as api from '../api/models'

// ── 假的名单 ────────────────────────────────────────────────────────

/** 一套对话模型（拿来看照片、听懂话的那类）。 */
const CHAT = (id: number, o: Partial<PublicConfig> = {}): PublicConfig => ({
  id, kind: 'chat', provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat',
  alias: '我的便宜货', keyHint: 'sk-…4f2', active: false, ...o,
})

/** 一套图片模型（真的把照片改掉的那类）。 */
const IMAGE = (id: number, o: Partial<PublicConfig> = {}): PublicConfig => ({
  id, kind: 'image', provider: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1', modelId: 'gpt-image-1',
  alias: '那个贵的', keyHint: 'sk-…9b1', active: false, ...o,
})

let store: PublicConfig[]
let nextId: number
let container: HTMLElement
let root: Root

beforeEach(() => {
  store = []
  nextId = 100
  // ⚠️ **必须清调用记录**：不清的话上一条用例留下的 `updateModel(1, {...})`
  //    会跟着走进下一条，`not.toHaveBeenCalledWith` 那几条否定断言就会
  //    红在一个和本用例毫无关系的地方（第一版正是这么红的）。
  vi.clearAllMocks()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  vi.mocked(api.listModels).mockImplementation(async () => ({ configs: store.map((c) => ({ ...c })) }))
  vi.mocked(api.createModel).mockImplementation(async (body) => {
    const b = body as { kind: ModelKind; alias: string; baseUrl: string; modelId: string; apiKey: string }
    const made: PublicConfig = {
      id: nextId++, kind: b.kind, provider: 'openai-compatible',
      baseUrl: b.baseUrl, modelId: b.modelId, alias: b.alias,
      keyHint: `sk-…${b.apiKey.slice(-3)}`, active: false,
    }
    store.push(made)
    return { ...made }
  })
  vi.mocked(api.updateModel).mockImplementation(async (id, body) => {
    const b = body as Partial<PublicConfig>
    const c = store.find((x) => x.id === id)!
    if (b.alias !== undefined) c.alias = b.alias
    if (b.modelId !== undefined) c.modelId = b.modelId
    if (b.baseUrl !== undefined) c.baseUrl = b.baseUrl
    return { ...c }
  })
  vi.mocked(api.deleteModel).mockImplementation(async (id) => {
    const gone = store.find((x) => x.id === id)!
    store = store.filter((x) => x.id !== id)
    return { wasActive: gone.active }
  })
  vi.mocked(api.activateModel).mockImplementation(async (kind, id) => {
    store = store.map((c) => (c.kind === kind ? { ...c, active: c.id === id } : c))
    return { ok: true as const }
  })
  vi.mocked(api.testModel).mockResolvedValue({ ok: true, models: [] })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ── 三个"用户动作" ─────────────────────────────────────────────────

async function show() {
  await act(async () => {
    root.render(<ModelSettings />)
    // 挂载时那一次「拉名单」得落定，不然看到的是"还在打开"那一瞬间
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** 点一下。**按文字找按钮**，不按位置 —— 位置是排版的事，文字才是用户的认知。 */
async function click(el: Element | null) {
  if (!el) throw new Error('要点的这个东西不在页面上')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** 在一格输入框里打字。非受控地写 value 的话 React 收不到 —— 走原生 setter。 */
async function type(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// ── 找东西 ────────────────────────────────────────────────────────

function inPart(where: ParentNode, text: string): HTMLButtonElement {
  const b = [...where.querySelectorAll('button')].find(
    (x) => (x.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
  if (!b) throw new Error(`这里没有「${text}」这颗按钮`)
  return b
}

function group(title: string): HTMLElement {
  const g = [...container.querySelectorAll<HTMLElement>('.models-group')].find(
    (el) => (el.querySelector('.models-group-title')?.textContent ?? '').startsWith(title))
  if (!g) throw new Error(`页面上没有「${title}」这一栏`)
  return g
}

function row(alias: string): HTMLElement {
  const r = [...container.querySelectorAll<HTMLElement>('.models-row')].find(
    (el) => (el.querySelector('.models-alias')?.textContent ?? '') === alias)
  if (!r) throw new Error(`名单里没有「${alias}」这一行`)
  return r
}

function field(id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`#model-${id}`)
  if (!el) throw new Error(`表单里没有「${id}」这一格`)
  return el
}

const form = () => container.querySelector('.models-form')
const nowLines = () =>
  [...container.querySelectorAll('.models-now')].map((el) => el.textContent ?? '')

async function openAdd(title: string) {
  await click(inPart(group(title), '添加一套'))
}

async function openEdit(alias: string) {
  await click(inPart(row(alias), '编辑'))
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('模型设置', () => {
  it('★ 空的时候说的是「用默认」，不是「没配置」', async () => {
    await show()
    // 两栏各说一句 —— 两个类别各自独立（§7.4），只画一句就成了"合在一起"的谎
    const now = nowLines()
    expect(now).toHaveLength(2)
    for (const t of now) expect(t).toContain('用默认（本服务提供）')
    // 「没配置」读起来像出错了；「用默认」才是事实：不配也有得用（顶部那句话）
    expect(container.textContent).not.toContain('没配置')
    // 变异：空状态只画一栏 / 那句话改成「没配置」 → 这一条红
  })

  it('★ 顶上那句在"存了但没启用"时也是真话 —— 「正在用的那一类」', async () => {
    // 这句原来写「配了的那一类」；而配置**存了但没激活**时（`server/models.ts` 是
    // 有意让新建的默认不激活的："用户可能只是想先存着"），`clientFor` 会安静地
    // 回默认 —— 同一栏两行之下的「当前：」正写着「用默认（本服务提供）」，
    // 页面自己跟自己打架。这句以前**没有任何测试断字面量**，所以它漂到了这儿。
    store = [CHAT(1, { active: false })]
    await show()
    expect(container.querySelector('.models-lede')?.textContent)
      .toBe('不配就用我们准备的；正在用的那一类，花的是你自己的额度。')
    // 变异：把这句改回「配了的那一类」→ 这一条红
  })

  it('★ 隐私那一句：照片和你说的话会出设备、经我们的手（§7.3「照说」/ §7.8）', async () => {
    // spec §7.3 明写「但隐私那一句照说」：照片会发给第三方模型服务商 ——
    // 不点名哪家，但**不瞒着"会发出去"这件事**。§7.8 三条都要在里面：
    // 发给谁 / 经不经过我们（**经过** —— 不许说"我们看不见"）/ 我们拿它干嘛（只转发）。
    // ⚠️ 什么都没配时这句也必须真（那会儿走的是我们准备的那家）—— 所以它
    //    不能写成"你配的模型……"。下面这个状态正是"什么都没配"。
    await show()
    expect(container.querySelector('.models-privacy')?.textContent)
      .toBe('照片和你说的话会经过我们的服务器转给第三方模型服务商；我们只转发，不拿去训练。')
    // 变异：把这一句删掉 → 上面这条红（null）
  })

  it('★ 页面上不出现任何型号名或我们的地址（§7.3 那条变异测试）', async () => {
    store = [
      CHAT(1, { alias: '我的便宜货', modelId: 'deepseek-chat', active: true }),
      IMAGE(2, { alias: '那个贵的', modelId: 'gpt-image-1' }),
    ]
    await show()
    // 前提：名单**真的画出来了**。少了这一句，下面几条否定断言会因为
    // "整页什么都没渲染"而白白通过 —— 否定断言最典型的假绿。
    expect(container.querySelectorAll('.models-row')).toHaveLength(2)
    expect(container.textContent).toContain('我的便宜货')

    const said = document.body.textContent ?? ''
    expect(said).not.toContain('deepseek-chat')
    expect(said).not.toContain('gpt-image-1')
    expect(said).not.toContain('sensenova')
    expect(said).not.toContain('token.sensenova.cn')
    // ★ 下面两条是**用户自己的**地址（就是上面两个 fixture 的主机名）。
    //   列表上只许有名字，地址要翻进编辑表单才露（§7.4）。
    //   少了它们这一半就红不了：fixture 里本来就没有我们自己的地址，
    //   而 `value`/`placeholder` 根本不进 textContent ——
    //   把地址画进那一行时，那几条断言照样绿。
    expect(said).not.toContain('api.deepseek.com')
    expect(said).not.toContain('api.example.com')
    // 变异：把型号名**或地址**画进那一行或任何列表文字里 → 这一条红
  })

  it('★ 型号名只在编辑表单里露 —— 翻开来就看得见（§7.4）', async () => {
    // 上一条钉的是"别处不许有"，这一条钉的是"该有的地方要有" ——
    // 两条合起来，上一条的否定断言才有靶子（不然把型号名删干净也算"绿"）。
    store = [CHAT(1, { modelId: 'deepseek-chat' })]
    await show()
    expect(container.textContent).not.toContain('deepseek-chat')

    await openEdit('我的便宜货')
    expect(field('name').value).toBe('deepseek-chat')
  })

  it('★ 用户只写域名也认 —— 原样发给服务端（归一化是服务端的事）', async () => {
    // ★ 和 brief 上那条的**说法**不一样，行为是同一个：brief 写的是
    //   「接口地址归一是前端做的」，实际不是 —— `normalizeBaseUrl` 在
    //   `server/models.ts` 里（Task 3 就上了），补协议、补 /v1、剥误粘的端点
    //   全在那边。前端唯一的职责是**别自作聪明**：他打成什么样就发什么样。
    //   两处各补各的，规则迟早走岔（`src/api/models.ts` 里那段注释说的是同一件事）。
    await show()
    await openAdd('对话与理解')
    await type(field('alias'), '出差那套')
    await type(field('url'), 'api.domain.com')
    await type(field('key'), 'sk-abc123')
    await type(field('name'), 'qwen-max')

    await click(inPart(form()!, '测一下'))
    // 原样 —— 我们既没补 https://，也没补 /v1
    expect(api.testModel).toHaveBeenCalledWith({ baseUrl: 'api.domain.com', apiKey: 'sk-abc123' })

    await click(inPart(form()!, '保存'))
    expect(api.createModel).toHaveBeenCalledWith({
      kind: 'chat', provider: 'openai-compatible', alias: '出差那套',
      baseUrl: 'api.domain.com', apiKey: 'sk-abc123', modelId: 'qwen-max',
    })
    // 变异：前端自己补上 https:// 或 /v1 再发 → 这一条红
  })

  it('★ 接口地址新建时是空的；placeholder 只许是「保留示例域名」', async () => {
    // §7.3：不暴露我们自己用的是哪家。预填（或者拿**我们的地址**当提示文字）等于
    // 把"我们用的是谁"写在用户脸上 —— 而且他多半会原样存下来，从此走我们的额度。
    //
    // ★ 2026-10-05：用户发来别家的表单说「你看人家的引导」——人家给地址格配了示例。
    //   我们跟进了，但**只许用 `example.com`**：RFC 2606 的保留域名，谁都注册不了，
    //   它永远不可能是我们自己或任何真实服务商的地址 —— 教的是"填什么样的"，
    //   不泄露"我们用的是谁"。判据从"必须为空"改成**钉死这一个值**：比原来更具体，
    //   防的东西没变（任何真实地址都过不了）。
    await show()
    await openAdd('图片生成')
    const url = field('url')
    expect(url.value).toBe('')
    expect(url.placeholder).toBe('https://api.example.com/v1')
    expect(document.body.textContent ?? '').not.toContain('sensenova')
    // 变异：placeholder 换成任何真实地址（包括我们自己的）→ 第二条红
  })

  it('★ 新建表单顶部有一句"我在填什么"的点题（2026-10-05 照别家的引导学的）', async () => {
    // 列表页那句 lede 讲"要不要配"；这一句讲"这一格一格是在配什么"。
    store = [CHAT(7, { alias: '出差那套' })]
    await show()
    await openAdd('图片生成')
    expect(container.querySelector('.models-form-lede')?.textContent)
      .toBe('填一个兼容 OpenAI 协议的服务 —— 哪一家都行。')
    // 编辑已有的一套时不出现 —— 他早懂了，不重复唠叨
    await click(inPart(form()!, '取消'))
    await openEdit('出差那套')
    expect(container.querySelector('.models-form-lede')).toBeNull()
  })

  it('★ 改了接口地址却不重填钥匙 —— 存不下去，而且说的是服务端那句话', async () => {
    // ★ 这是 `PATCH /api/models/:id` 的一条**故意的安全性质**（server/models.ts）：
    //   改了地址就必须在同一个请求里带上钥匙，否则 400。防的是"偷到会话的人
    //   把存着的钥匙引到自己的服务器上去"。界面这边的本分是**让他根本撞不上**：
    //   本地挡住、说清楚为什么，绝不发一次注定 400 的请求。
    store = [CHAT(1)]
    await show()
    await openEdit('我的便宜货')
    await type(field('url'), 'api.other-vendor.com')

    await click(inPart(form()!, '保存'))
    expect(api.updateModel).not.toHaveBeenCalled()
    expect(container.querySelector('.models-error')?.textContent).toContain(
      '换了接口地址就要把钥匙重填一遍')
    // (和服务端一个字不差 —— 同一个毛病不该有两种说法)

    // 补上钥匙就能存了，而且地址和钥匙是**同一个请求**里的
    await click(inPart(form()!, '换一把'))
    await type(field('key'), 'sk-new-key')
    await click(inPart(form()!, '保存'))
    expect(api.updateModel).toHaveBeenCalledWith(1, {
      alias: '我的便宜货', modelId: 'deepseek-chat',
      baseUrl: 'api.other-vendor.com', apiKey: 'sk-new-key',
    })
    // 变异：去掉本地那道 guard → updateModel 被调用了 → 这一条红
  })

  it('★ 只改别名：请求里**不许**出现 baseUrl（带了就是逼他重填钥匙）', async () => {
    // 服务端判"要不要重填钥匙"看的是请求里**有没有 baseUrl**，不是它变没变。
    // 所以没动过的地址一个字都不能提 —— 提了就等于要求用户重填，
    // 而那个值和库里一模一样，他只会觉得这一页在为难人。
    store = [CHAT(1)]
    await show()
    await openEdit('我的便宜货')
    expect(field('url').value).toBe('https://api.deepseek.com/v1')   // 他自己的地址，预填
    await type(field('alias'), '换了个名字')
    await click(inPart(form()!, '保存'))

    expect(api.updateModel).toHaveBeenCalledWith(1, { alias: '换了个名字', modelId: 'deepseek-chat' })
    expect(api.updateModel).not.toHaveBeenCalledWith(1, expect.objectContaining({ baseUrl: expect.anything() }))
    // 变异：无条件把 baseUrl 放进请求体 → 这一条红（真服务端会 400）
  })

  it('★ 钥匙永不回显：编辑时那一格显示的是 keyHint，明文一个字母都没有（§7.7）', async () => {
    store = [CHAT(1, { keyHint: 'sk-…4f2' })]
    await show()
    await openEdit('我的便宜货')

    expect(container.querySelector('.models-keyrow')?.textContent).toContain('sk-…4f2')
    // 收起状态：根本没有那把钥匙的输入框
    expect(container.querySelector('input[type="password"]')).toBeNull()

    await click(inPart(form()!, '换一把'))
    const key = field('key')
    expect(key.type).toBe('password')       // 肩窥这一层至少挡一下
    expect(key.value).toBe('')              // ★ 而且**不许预填**（连 hint 都不许填进去）
    // 变异：把 keyHint 填进 value 当"默认值" → 这一条红
  })

  it('★ keyHint 是「（读不出来，请重填）」时，那一行要显眼并且当场给「换一把」', async () => {
    store = [CHAT(1, { keyHint: UNREADABLE_KEY_HINT }), IMAGE(2)]
    await show()
    await openEdit('我的便宜货')

    // 显眼 = 单独一个类，样式上按"出事了"处理（`.models-keybad`）
    expect(container.querySelector('.models-keybad')?.textContent).toBe(UNREADABLE_KEY_HINT)
    expect(inPart(group('对话与理解'), '换一把')).toBeTruthy()
    expect(container.textContent).toContain('这一把读不出来了')

    // 另一栏那套钥匙好好的，就不该跟着变红
    await click(inPart(row('那个贵的'), '编辑'))
    expect(container.querySelector('.models-keybad')).toBeNull()
    // 变异：那一行的类去掉（读不出来的钥匙长得和正常的一模一样）→ 这一条红
  })

  it('★ 删掉正在用的那套 → 出现那条提示，而且带一个「换成其他的」入口', async () => {
    store = [CHAT(1, { alias: '我的便宜货', active: true }), CHAT(2, { alias: '那个快的' })]
    await show()
    await click(inPart(row('我的便宜货'), '删除'))

    expect(api.deleteModel).toHaveBeenCalledWith(1)
    const warn = container.querySelector('.models-warn')
    expect(warn?.textContent).toContain('你删掉的这套，正是你现在在用的对话模型。')
    expect(warn?.textContent).toContain('已经切回默认模型了。')
    // ★ 「鲜明提示 + 一个入口」是 §7.4 的原话。**只提示不给入口 = 把人扔在半路**：
    //   他知道了"已经切回默认"，可接下来想换成另一套，还得自己再找一遍入口。
    const swap = warn ? inPart(warn, '换成其他的') : null
    expect(swap).toBeTruthy()

    // 删掉的那一行真的没了，当前也真的回到默认了（不是只嘴上说说）
    expect(container.querySelectorAll('.models-row')).toHaveLength(1)
    expect(group('对话与理解').querySelector('.models-now')?.textContent).toContain('用默认')

    // 那个入口得**真的把人送到能换的地方**（这个项目不许有"点了哪都不去"的按钮）
    await click(swap)
    expect(form()).toBeTruthy()
    expect(container.querySelector('.models-form-title')?.textContent).toContain('添加一套')
    // 变异：忽略服务端回的 wasActive → 提示根本不出现 → 这一条红
    // 变异：只画提示、不画「换成其他的」→ 这一条红
  })

  it('★ 删掉不是在用的那套 → 一句提示都不许有', async () => {
    // §7.4 的原话就是"就删掉，什么都不变"。不是在用的那套删了，
    // 用户的活儿一点没受影响 —— 这时候弹一句"已经切回默认了"是**假话**，
    // 还会让他以为出了什么事。
    store = [CHAT(1, { alias: '我的便宜货', active: true }), CHAT(2, { alias: '那个快的' })]
    await show()
    await click(inPart(row('那个快的'), '删除'))

    expect(container.querySelectorAll('.models-row')).toHaveLength(1)
    expect(container.querySelector('.models-warn')).toBeNull()
    expect(container.querySelector('.models-error')).toBeNull()
    // 变异：不看 wasActive、删完一律弹提示 → 这一条红
  })

  it('★ 激活之后那条警告必须消失 —— 一屏上不许同时站着两句"现在"', async () => {
    // 警告是"删除那一刻"的快照。用户删完随手又点了「用这个」或「用回默认」，
    // 它还挂着的话，两句互相打架的现状描述就同时停在屏幕上（相隔两次点击）：
    // 一句说"已经切回默认了"，另一句（✓ 和「当前：」）说正在用另一套。
    // 「用这个」和「用回默认」是两条路，所以两条都走一遍。
    store = [
      CHAT(1, { alias: '我的便宜货', active: true }),
      CHAT(2, { alias: '那个快的' }),
      IMAGE(3, { alias: '那个贵的', active: true }),
    ]
    await show()
    await click(inPart(row('我的便宜货'), '删除'))          // 删的是在用的那套
    const chat = group('对话与理解')
    expect(chat.querySelector('.models-warn')).toBeTruthy()

    // 路一：切到另一套（「用这个」）—— 警告立刻撤掉
    await click(inPart(row('那个快的'), '用这个'))
    expect(chat.querySelector('.models-warn')).toBeNull()
    expect(chat.querySelector('.models-now')?.textContent).toContain('那个快的')

    // 路二：「用回默认」也要清。先把图片那栏的警告点出来 ——
    //   这是"警告还挂着、同时又存在着可以用回默认的那一套"唯一到得了的状态，
    //   同一栏里点了「用这个」之后警告已经被路一清掉了。
    await click(inPart(row('那个贵的'), '删除'))
    const image = group('图片生成')
    expect(image.querySelector('.models-warn')).toBeTruthy()
    await click(inPart(chat, '用回默认'))
    expect(container.querySelector('.models-warn')).toBeNull()
    // 变异：onActivate 开头那句 setWarn(null) 删掉 → 这一条红
  })

  it('★ 删掉的正是编辑表单里开着的那一套 → 表单跟着收起来（不然保存打过去是 404）', async () => {
    // 表单开着、用户正在改名字，同一行的「删除」就杵在旁边。删掉之后表单还留着的话，
    // 里面那颗「保存」发过去打的是一个已经不存在的 id —— 服务端 404，
    // 屏幕上只说"存不上"，他会以为是网络抽风，然后照着重试。
    store = [CHAT(1, { alias: '我的便宜货' }), IMAGE(2, { alias: '那个贵的' })]
    await show()
    await openEdit('我的便宜货')
    expect(form()).toBeTruthy()

    // 开着 A 的表单去删**别的**那一套：表单不许动（他正敲着字呢）
    await click(inPart(row('那个贵的'), '删除'))
    expect(form()).toBeTruthy()

    await click(inPart(row('我的便宜货'), '删除'))
    expect(form()).toBeNull()
    // 变异：onDelete 里不管 form（删完表单还留着）→ 这一条红
  })

  it('删失败时把服务端那句话说出来（不自己编一句糊弄过去）', async () => {
    store = [CHAT(1)]
    await show()
    vi.mocked(api.deleteModel).mockRejectedValueOnce(
      new ApiError('INTERNAL', '没删掉，服务器那边打结了。'))
    await click(inPart(row('我的便宜货'), '删除'))
    expect(container.querySelector('.models-error')?.textContent).toContain('服务器那边打结了')
    // 变异：把 catch 吞掉（屏幕上一点动静都没有）→ 这一条红
  })

  it('★ 测一下：失败时把服务商那句话原样显示出来', async () => {
    // 探不通也是 200（那是"这次探活的结果"，不是"请求失败了"）——
    // 所以这句话走的是**正常路径**，不能靠 catch 兜。
    await show()
    await openAdd('对话与理解')
    await type(field('url'), 'api.domain.com')
    await type(field('key'), 'sk-abc123')
    vi.mocked(api.testModel).mockResolvedValueOnce({
      ok: false, reason: 'unauthorized', message: '这把钥匙服务商不认（401），检查一下有没有粘错。',
    })
    await click(inPart(form()!, '测一下'))

    expect(container.querySelector('.models-probe-bad')?.textContent)
      .toContain('这把钥匙服务商不认（401），检查一下有没有粘错。')
    // 变异：画一句我们自己编的（"连接失败"之类）→ 这一条红。
    // 上游原文是服务端特意挡在里面的：用户要看到的是**那边**说了什么，
    // 我们替他翻译只会把排查线索翻译没。
  })

  it('★ 「测一下」只验地址和钥匙 —— 这句话永远挂在按钮旁边（§7.3）', async () => {
    // 这个按钮能存在的前提就是这句说明：它证明的只是"地址通、钥匙对"，
    // **不是**"那个模型能用"。少了它，这个按钮就在替我们说一句我们做不到的话。
    await show()
    await openAdd('对话与理解')
    // 新建时表单是空的，而"测一下"要的就是表单里这份值 —— 所以先填上地址和钥匙，
    // 不然它连试都试不了（那种情况给的是「接口地址不能为空」，见下面那条）。
    await type(field('url'), 'api.domain.com')
    await type(field('key'), 'sk-abc123')
    const probe = container.querySelector('.models-probe')!
    expect(inPart(probe, '测一下')).toBeTruthy()
    expect(probe.textContent).toContain('只验地址和钥匙通不通，不代表那个模型一定能用。')

    // 测通了之后也不许把它撤掉 —— 通了恰恰是最容易让人误解的时候
    vi.mocked(api.testModel).mockResolvedValueOnce({ ok: true, models: ['qwen-max'] })
    await click(inPart(probe, '测一下'))
    expect(container.querySelector('.models-probe-ok')?.textContent).toContain('通了')
    expect(container.querySelector('.models-probe')?.textContent)
      .toContain('只验地址和钥匙通不通，不代表那个模型一定能用。')
    // 变异：删掉那行说明 → 这一条红
  })

  it('★ 探活结果只对"刚测的那一份表单"有效 —— 改了任一格就必须撤下', async () => {
    // 测通 A 家之后把地址改成 B 家，屏幕上**仍写着**「通了，地址和钥匙都对。」——
    // 而 B 家从没被验过；下拉里那份型号名单也还是 A 家的。这正是这一版反复抓的
    // 那类假话：拿"过去某一刻为真"的一句话，对着现在这一刻说 —— 而且它正落在
    // 本功能最核心的那句断言上（§7.3「地址通、钥匙认」）。
    await show()
    await openAdd('对话与理解')
    await type(field('url'), 'api.deepseek.com')
    await type(field('key'), 'sk-abc123')

    // ★ 每测一次都先确认"这一下真的测出来了"，不然下面的撤下断言会因为
    //   "从来就没出现过"而白白通过（否定断言最典型的假绿）。
    const probeOnce = async () => {
      vi.mocked(api.testModel).mockResolvedValueOnce({ ok: true, models: ['deepseek-chat'] })
      await click(inPart(form()!, '测一下'))
      expect(container.querySelector('.models-probe-ok')?.textContent).toBe('通了，地址和钥匙都对。')
    }

    await probeOnce()
    expect(container.querySelectorAll('datalist option')).toHaveLength(1)

    // ① 地址换成另一家 —— 那句"地址和钥匙都对"不再是对此刻这份表单说的话
    await type(field('url'), 'api.other-vendor.com')
    expect(container.querySelector('.models-probe-ok')).toBeNull()
    expect(container.querySelector('.models-probe-bad')).toBeNull()
    // 名单也得跟着撤 —— 那是"上一家"看得见的型号，照着它填只会让用户存进一个
    // 这一家根本不认的模型名
    expect(container.querySelectorAll('datalist option')).toHaveLength(0)

    // ② 钥匙换了 —— 新粘的这把没验过
    await probeOnce()
    await type(field('key'), 'sk-someone-else')
    expect(container.querySelector('.models-probe-ok')).toBeNull()

    // ③ 模型名也动过 —— 那句话说的是"刚测的那一份"，表单动过就不算数
    await probeOnce()
    await type(field('name'), 'qwen-max')
    expect(container.querySelector('.models-probe-ok')).toBeNull()
    // 变异：渲染条件退回只认 `probe.state === 'done'`（不比对测的是哪一份）→
    //      上面三处"撤下"断言各红一次；只撤结果不撤名单 → 名单那条红
  })

  it('测通了：把上游的模型名单放进下拉里，而且**还能手打**（商汤的列表不全）', async () => {
    await show()
    await openAdd('对话与理解')
    await type(field('url'), 'api.domain.com')
    await type(field('key'), 'sk-abc123')
    vi.mocked(api.testModel).mockResolvedValueOnce({ ok: true, models: ['qwen-max', 'qwen-plus'] })
    await click(inPart(form()!, '测一下'))

    const list = container.querySelector('datalist')
    expect([...list!.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toEqual(['qwen-max', 'qwen-plus'])
    expect(field('name').getAttribute('list')).toBe(list!.id)

    // 手打一个**不在名单里**的（我们自己在用的那个就不在里面）—— 打得进去
    expect(field('name').readOnly).toBe(false)
    expect(field('name').disabled).toBe(false)
    await type(field('name'), 'sensenova-6.8-flash-lite')
    expect(field('name').value).toBe('sensenova-6.8-flash-lite')
    // 变异：把这一格改成只读的选择框 → 这一条红
  })

  it('★ 「用这个」和「用回默认」：两栏各管各的（§7.4 / §9）', async () => {
    store = [CHAT(1, { alias: '我的便宜货', active: true }), CHAT(2, { alias: '那个快的' }), IMAGE(3)]
    await show()

    // 在用的那一行已经有 ✓ 了，不再给一颗"再点一次"的按钮 ——
    // 按了没反应最让人迷惑
    expect([...row('我的便宜货').querySelectorAll('button')].map((b) => b.textContent?.trim()))
      .toEqual(['编辑', '删除'])

    await click(inPart(row('那个快的'), '用这个'))
    expect(api.activateModel).toHaveBeenCalledWith('chat', 2)
    // 换过去了：✓ 跟着走，当前那行也变了
    // ★ 2026-10-01：那个 ✓ 从**字符**换成了**图标**（lucide 的 Check），
    //   所以这里断言的是"记号落到了哪一行"，不再是某个字符 ——
    //   意思一个字没变，而且顺带把"旧那行还留着记号"也钉住了。
    expect(row('那个快的').querySelector('.models-mark svg')).toBeTruthy()
    expect(row('我的便宜货').querySelector('.models-mark svg')).toBeNull()
    expect(group('对话与理解').querySelector('.models-now')?.textContent).toContain('那个快的')
    // ★ 图片那一栏**纹丝不动** —— 两个类别各自独立（§7.4）
    expect(group('图片生成').querySelector('.models-now')?.textContent).toContain('用默认')

    await click(inPart(group('对话与理解'), '用回默认'))
    // §9：想回默认得有条路，不然只能"把这套删掉"（那是拿删除当开关用，还丢配置）
    expect(api.activateModel).toHaveBeenCalledWith('chat', null)
    expect(group('对话与理解').querySelector('.models-now')?.textContent).toContain('用默认')
    // 变异：把 kind 写死成 'chat'（图片那栏也跟着切）→ 这一条红
  })

  it('★ 新建一套：该发的字段发全，存完回名单（别把用户扔在表单里）', async () => {
    await show()
    await openAdd('图片生成')
    await type(field('alias'), '出差那套')
    await type(field('url'), 'api.example.com')
    await type(field('key'), 'sk-abc123')
    await type(field('name'), 'gpt-image-1')
    await click(inPart(form()!, '保存'))

    expect(api.createModel).toHaveBeenCalledWith({
      kind: 'image', provider: 'openai-compatible', alias: '出差那套',
      baseUrl: 'api.example.com', apiKey: 'sk-abc123', modelId: 'gpt-image-1',
    })
    // 存完：表单收起来、名单里真的有它了（这两件都是用户能看见的）
    expect(form()).toBeNull()
    expect(row('出差那套')).toBeTruthy()
    // 变异：kind 写死成 'chat'（图片那栏存进去的其实是对话模型）→ 这一条红
  })

  it('新建时缺字段存不下去，说的是人话（不是"400 Bad Request"）', async () => {
    await show()
    await openAdd('对话与理解')
    await click(inPart(form()!, '保存'))
    expect(api.createModel).not.toHaveBeenCalled()
    expect(container.querySelector('.models-error')?.textContent).toBe('给它起个名字吧')

    await type(field('alias'), '出差那套')
    await click(inPart(form()!, '保存'))
    expect(container.querySelector('.models-error')?.textContent).toBe('接口地址不能为空')

    await type(field('url'), 'api.example.com')
    await click(inPart(form()!, '保存'))
    expect(container.querySelector('.models-error')?.textContent).toBe('钥匙不能为空')
    // 变异：去掉本地这几道 guard → 发出去的请求缺字段 → 这一条红
  })

  it('★ 名单拉不到：说出来 + 给下一步，**绝不**画成"一套都没有"', async () => {
    // ★ 这是这一页最要命的一条假话：拉不到名单却画成空名单，等于对一个配了
    //   三套模型的用户说"你什么都没配"，而且他会照着这个画面去重配一遍。
    //   （和用户管理页「0 张作品」那一条是同一个毛病，见 AccountPage 的注释。）
    vi.mocked(api.listModels).mockRejectedValueOnce(
      new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？'))
    await show()

    expect(container.querySelector('.models-error')?.textContent).toContain('连不上服务器')
    // 说"不行"的地方都要同时说"那怎么办"（《文案规范》：哪不对 + 怎么办）
    expect(container.textContent).toContain('刷新一下页面，再试一次')
    // 两栏都不许出现 —— 尤其不许出现「用默认（本服务提供）」
    expect(container.querySelector('.models-group')).toBeNull()
    expect(container.textContent).not.toContain('用默认')
    // 变异：拿不到时 `setConfigs([])`（画成空名单）→ 这一条红
  })

  it('「编辑」「删除」「添加一套」都有活干 —— 页面上不许有点了哪都不去的按钮', async () => {
    // 这几颗按钮的**行为**分散在上面各条里测了，这里盯的是"每一颗都接上了东西"
    // 这回事本身：少了这颗钉子，加回一颗空按钮（或者把 onClick 漏掉）没人会发现。
    store = [CHAT(1)]
    await show()
    await openEdit('我的便宜货')
    expect(form()).toBeTruthy()
    await click(inPart(form()!, '取消'))
    expect(form()).toBeNull()

    await openAdd('对话与理解')
    expect(container.querySelector('.models-form-title')?.textContent).toContain('添加一套')
    // 变异：某颗按钮的 onClick 删掉 → 上面某一条（或这一条）红
  })
})
