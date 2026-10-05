// @vitest-environment jsdom
/**
 * 对话列表（Task 6，spec §6.1 / §6.3）。
 *
 * ⚠️ 这一份 mock 的是 `src/api/sessions.ts` 那一层，不是 `fetch`：这个文件要测的是
 *    "列表怎么摆、删之前问不问、没有的时候说什么"，请求本身怎么拼归 `api/client.ts`
 *    那一层自己的测试。
 *
 * ⚠️ 时间**冻住**（`vi.useFakeTimers({ toFake: ['Date'] })`，只冻 Date 不冻
 *    setTimeout —— 挂载那一次请求要靠真定时器落定）。不冻的话「今天/昨天/去年」
 *    那组标题会随着跑测试的时刻漂，跨零点时红得莫名其妙。
 *
 * ⚠️ 这一页**没有一条断言是看像素的**：分组标题、那几个按钮、空态那句话，
 *    全按文字找 —— 排版是 `check-mobile-layout.mjs` 的事。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayLabel } from '../../shared/works.ts'
import type { SessionMeta } from '../../shared/sessions.ts'
import { SessionsPage } from './SessionsPage'

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
  }
})

import * as api from '../api/sessions'

// ── 冻结的"现在"和几条会话 ─────────────────────────────────────────

/** 冻住的「现在」。定在晚上而不是零点：跨天那几条边界离得远，测试不是运气题。 */
const NOW = new Date('2026-10-01T20:00:00')
const at = (s: string) => new Date(s).getTime()

/** 一条会话。标题给足了，好让"这条是哪条"在断言里一眼看得见。 */
const ses = (id: number, o: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `第 ${id} 条`,
  originalName: null,
  createdAt: at('2026-10-01T09:00:00'),
  updatedAt: at('2026-10-01T09:00:00'),
  hasThumb: true,
  stepCount: 2,
  ...o,
})

let rows: SessionMeta[] | null
let listFailed: Error | null
let deleteFailed: Error | null
/** 改名请求的流水 —— 「两条保存路径合起来只发一次」那条断言靠它 */
let renameCalls: { id: number; patch: { title?: string } }[]
/** 让下一次改名失败用 */
let renameFail: Error | null
/** 手动放行的"还没回来"那一瞬间用 */
let holdList: (() => void) | null

let container: HTMLElement
let root: Root
let onOpen: ReturnType<typeof vi.fn>
let onNew: ReturnType<typeof vi.fn>
let onDeleted: ReturnType<typeof vi.fn>

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  rows = []
  listFailed = null
  deleteFailed = null
  holdList = null
  renameCalls = []
  renameFail = null

  vi.mocked(api.listSessions).mockImplementation(() => {
    if (holdList) return new Promise((resolve) => { holdList = () => resolve(rows ?? []) })
    if (listFailed) return Promise.reject(listFailed)
    return Promise.resolve(rows ?? [])
  })
  vi.mocked(api.deleteSession).mockImplementation(async (id) => {
    if (deleteFailed) throw deleteFailed
    rows = (rows ?? []).filter((r) => r.id !== id)
  })
  vi.mocked(api.updateSession).mockImplementation(async (id, patch) => {
    renameCalls.push({ id, patch })
    if (renameFail) throw renameFail
    const before = (rows ?? []).find((r) => r.id === id)!
    const meta = { ...before, title: (patch.title ?? '').trim() || null }
    rows = (rows ?? []).map((r) => (r.id === id ? meta : r))
    return meta
  })

  onOpen = vi.fn()
  onNew = vi.fn()
  onDeleted = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

// ── 动作和找东西 ───────────────────────────────────────────────────

async function show() {
  await act(async () => {
    root.render(<SessionsPage onOpen={onOpen} onNew={onNew} onDeleted={onDeleted} />)
    // 挂载那一次「拉列表」得落定，不然看到的是"还在取"那一瞬间
    await tick()
  })
}

/** 点一下。**按文字找按钮** —— 位置是排版的事，文字才是用户的认知。 */
async function click(el: Element | null) {
  if (!el) throw new Error('要点的这个东西不在页面上')
  await act(async () => {
    ;(el as HTMLElement).click()
    await tick()
  })
}

function inPart(where: ParentNode, text: string): HTMLButtonElement | null {
  return ([...where.querySelectorAll('button')].find(
    (x) => (x.textContent ?? '').trim() === text) ?? null) as HTMLButtonElement | null
}

const btn = (text: string) => inPart(container, text)
const heads = () => [...container.querySelectorAll('.gallery-day-title')].map((e) => e.textContent ?? '')
const names = () => [...container.querySelectorAll('.session-name')].map((e) => e.textContent ?? '')
const namesIn = (r: Element) => [...r.querySelectorAll('.session-name')].map((e) => e.textContent ?? '')
const rowOf = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('.session-row')]
    .find((r) => namesIn(r).includes(name)) ?? null
const texts = () => container.textContent ?? ''

/**
 * 某一行末尾那颗「…」（★ 2026-10-06 下午：行操作收进了菜单）。
 * ⚠️ 图标键 —— 只能按类名找（和左栏「个人设置」那颗同一条规矩）。
 */
function moreIn(row: Element): HTMLButtonElement {
  const el = row.querySelector('.session-more')
  if (!el) throw new Error('这一行上没有「…」')
  return el as HTMLButtonElement
}
/** 一行和它下面可能开着的菜单是**一对**：菜单挂在同一个块里、是行的兄弟。 */
function blockOf(name: string): HTMLElement {
  const r = rowOf(name)
  if (!r) throw new Error(`没有「${name}」这一行`)
  return r.parentElement as HTMLElement
}
/** 「…」→ 菜单里点某一项（改名 / 删除）—— 行操作现在都要**先点开菜单**。 */
async function viaMenu(name: string, item: string) {
  await click(moreIn(rowOf(name)!))
  await click(inPart(blockOf(name), item))
}

// ── 测试 ───────────────────────────────────────────────────────────

describe('对话列表', () => {
  it('★ 按天分组，和作品页用**同一套** dayKey / dayLabel', async () => {
    // 四条的摆法是有讲究的：两条**同一天不同时刻**（分组要按天不按条）、
    // 一条昨天、一条去年（`dayLabel` 那条"不是今年才带年份"的规矩）。
    const todayLate = ses(4, { updatedAt: at('2026-10-01T18:00:00') })
    const todayEarly = ses(3, { updatedAt: at('2026-10-01T09:00:00') })
    const yest = ses(2, { updatedAt: at('2026-09-30T21:00:00') })
    const lastYear = ses(1, { updatedAt: at('2025-12-31T10:00:00') })
    rows = [yest, lastYear, todayEarly, todayLate]
    await show()

    // 标题**就是**作品页那套 helper 算出来的那个串 —— 这里不写死字面量，
    // 写死了就成了"第二套规则"，作品页哪天改了口径这一条也不会红。
    expect(heads()).toEqual([
      `${dayLabel(todayLate.updatedAt, NOW.valueOf())} · 2 条`,
      `${dayLabel(yest.updatedAt, NOW.valueOf())} · 1 条`,
      `${dayLabel(lastYear.updatedAt, NOW.valueOf())} · 1 条`,
    ])
    // 同一天的两条合在一组，组内新的在前 —— 这是 `dayKey` 在干的事
    expect(names()).toEqual(['第 4 条', '第 3 条', '第 2 条', '第 1 条'])
    // 往年的那条真的带上了年份（不带上就说明这条页自己另写了一份日期格式）
    expect(heads()[2]).toContain('2025年')
    // 变异：自己写一份 `toLocaleDateString` 分组 → 第一条断言红；
    // 按"条"而不是按"天"分组 → 四个标题，第一条红。
  })

  it('★ 删一条要就地确认，**不弹系统框**', async () => {
    rows = [ses(7)]
    const confirmSpy = vi.spyOn(window, 'confirm')
    await show()

    await viaMenu('第 7 条', '删除')
    // 问在**原处**：那一行里冒出「删掉这条？」，而不是浏览器那个模态框；
    // 而且菜单**自己收掉了**（点完【删除】它就该走，别挂着）
    expect(texts()).toContain('删掉这条？')
    expect(inPart(blockOf('第 7 条'), '删除')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    // 还没答话，谁也不许删
    expect(api.deleteSession).not.toHaveBeenCalled()

    // 「取消」= 什么都没发生
    await click(inPart(rowOf('第 7 条')!, '取消'))
    expect(texts()).not.toContain('删掉这条？')
    expect(rowOf('第 7 条')).not.toBeNull()

    // 再来一次，这回认了
    await viaMenu('第 7 条', '删除')
    await click(inPart(rowOf('第 7 条')!, '删掉'))
    expect(api.deleteSession).toHaveBeenCalledWith(7)
    // 那一行当场走人（等下次刷新才消失的话，用户会以为没删掉）
    expect(rowOf('第 7 条')).toBeNull()
    // ★ 删**成功之后**要把 id 交回去（2026-10-02）：这一页不知道"现在正在改的是哪条"，
    //   App 才知道。删掉正在改的那条时，App 手上那份照片/对话/快照全靠这一声跟着走
    //   —— 不喊的话 `sessionId` 会一直指着一条已经不存在的会话。
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith(7)
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
    // 变异：改用 `window.confirm` → 第一条 not.toHaveBeenCalled 红；
    // 删完不动本地名单 → 最后那条 toBeNull 红；
    // 删成功不喊 `onDeleted` → 上面那两条红。
  })

  it('★ 一条会话都没有时，是一句"还没改过照片" + 一个去修图的入口，不是一个空列表', async () => {
    rows = []
    await show()

    expect(container.querySelector('.sessions-empty-title')?.textContent).toBe('还没改过照片。')
    expect(names()).toEqual([])
    // 而且不能是个**空壳列表**：一条行都没有（空的 `.sessions` 只是外面那一格，
    // 四种状态都住在它里面，见 SessionsPage.tsx 里那段注释）
    expect(container.querySelectorAll('.session-row')).toHaveLength(0)

    await click(btn('去改一张'))
    expect(onNew).toHaveBeenCalledTimes(1)
    // 空态里那颗按钮**不**顺手打开某条会话（一条都没有，也没有可打开的）
    expect(onOpen).not.toHaveBeenCalled()
    // 变异：空的时候照样画出那几行 → 第二条断言红。
  })

  it('还没拿到 ≠ 没有 —— 那一刻不许说"还没改过照片"', async () => {
    // 这一条单拎出来，是因为它是**最容易写错、后果最吓人**的一处：
    // 请求还在路上时显示空态，用户会以为东西全没了。
    let release!: () => void
    vi.mocked(api.listSessions).mockImplementation(() => new Promise((r) => { release = () => r([ses(1)]) }))
    await act(async () => {
      root.render(<SessionsPage onOpen={onOpen} onNew={onNew} onDeleted={onDeleted} />)
      await tick()
    })
    expect(texts()).toContain('正在取')
    expect(container.querySelector('.sessions-empty-title')).toBeNull()

    await act(async () => { release(); await tick() })
    expect(names()).toEqual(['第 1 条'])
    // 变异：把 `rows === null` 和 `rows.length === 0` 合成一个分支 → 第一条红。
  })

  it('删失败了：那一行还在、列表还在，只是多一句"没删掉"', async () => {
    // `failed` 那一个状态原本被**两个来源**共用（拉列表失败 / 删失败），
    // 而删失败时它是**悄悄把整页换成一行字** —— 一次网络抖动就能让用户
    // 以为"我的对话全没了"。所以删失败走的是另一条路：列表原样不动。
    rows = [ses(7, { title: '那条删不掉的' })]
    deleteFailed = new Error('没删掉，再试一次？')
    await show()

    await viaMenu('那条删不掉的', '删除')
    await click(inPart(rowOf('那条删不掉的')!, '删掉'))

    expect(api.deleteSession).toHaveBeenCalledWith(7)
    expect(rowOf('那条删不掉的')).not.toBeNull()   // 没删掉就是没删掉，别装作删掉了
    expect(texts()).toContain('没删掉')
    expect(container.querySelector('.sessions')).not.toBeNull()
    expect(container.querySelector('.sessions-empty-title')).toBeNull()
    // ★ 而且**不许喊 `onDeleted`**：那一声在 App 那边是"把手上的照片放下来"。
    //   服务端什么都没删掉，App 却把用户正在改的那张抹了 —— 一次网络抖动
    //   就能让他丢掉干到一半的活儿。
    expect(onDeleted).not.toHaveBeenCalled()
    // 变异：删失败也往 `failed` 那个状态上写 → 最后两条红；
    // 把 `onDeleted` 挪到 `await` 前面（或者 try 外面）→ 这一条红。
  })
  it('★ 行操作收进「…」菜单：点开有【改名】【删除】；再点一下收起；一次只开一条', async () => {
    // ★ 2026-10-06 下午（用户原话：「我看豆包是这种做法，放个这个图标在每段
    //   对话的最后，点击这个符号后里面有删除选项」）—— 说的就是这一页：
    //   原来行尾并排两颗裸按钮（改名 / 删除），现在收进一颗「…」里。
    rows = [ses(7), ses(8)]
    await show()

    // 平时：整页没有裸的「改名」「删除」按钮，只有每行末尾那颗「…」
    expect(btn('改名')).toBeNull()
    expect(btn('删除')).toBeNull()
    expect(container.querySelectorAll('.session-more')).toHaveLength(2)

    // 点开：菜单里就是那两项（【删除】在菜单里也还叫「删除」）
    await click(moreIn(rowOf('第 7 条')!))
    expect(inPart(blockOf('第 7 条'), '改名')).not.toBeNull()
    expect(inPart(blockOf('第 7 条'), '删除')).not.toBeNull()

    // 再点一下「…」→ 收起（和对话区那颗同一个开关逻辑）
    await click(moreIn(rowOf('第 7 条')!))
    expect(inPart(blockOf('第 7 条'), '改名')).toBeNull()

    // 开 A、再开 B：只剩 B 的菜单（一次一条 —— 两条菜单并排挂着的话，
    // 点「删除」删的是哪一条会变得要猜）
    await click(moreIn(rowOf('第 7 条')!))
    await click(moreIn(rowOf('第 8 条')!))
    expect(inPart(blockOf('第 7 条'), '改名')).toBeNull()
    expect(inPart(blockOf('第 8 条'), '改名')).not.toBeNull()
  })
})

// ── 多选批删（★ 2026-10-06 下午）────────────────────────────────────
//
// 他看过勾选框截图之后选的"两个都要"里的第二条路：菜单里的【多选】进"选择模式"
// ——每行一个勾选框、点行 = 勾选、底下一条操作条「已选 N 条 ｜ 删除 ｜ 取消」。
// 删前一律先问一句（一段会话里挂着照片、每一步的快照 —— 比一句话重得多）。
// 逐条调现成的 `deleteSession`（服务端零改动）；**部分失败不清场**：没删掉的
// 留在列表和勾里，用户可以直接再点一次。
describe('多选批删', () => {
  /** 进选择模式：某一行「…」→【多选】。 */
  async function enterSelect(name: string) {
    await click(moreIn(rowOf(name)!))
    await click(inPart(blockOf(name), '多选'))
  }
  const boxOf = (name: string) =>
    rowOf(name)!.querySelector('.session-pick') as HTMLInputElement

  it('菜单里的【多选】→ 选择模式：每行一个勾选框、「…」全收、底下出现操作条', async () => {
    rows = [ses(7), ses(8)]
    await show()
    await click(moreIn(rowOf('第 7 条')!))
    expect(inPart(blockOf('第 7 条'), '多选')).not.toBeNull()
    await click(inPart(blockOf('第 7 条'), '多选'))

    expect(container.querySelectorAll('.session-pick')).toHaveLength(2)
    expect(container.querySelectorAll('.session-more')).toHaveLength(0)   // 「…」全收
    expect(texts()).toContain('已选 0 条')
    expect(btn('删除')!.disabled).toBe(true)     // 一段没勾 → 禁用（不留点了没用的按钮）
    expect(btn('取消')).not.toBeNull()
  })

  it('勾一段算一段：点勾选框、点那一行都能勾；点行**不会**打开会话', async () => {
    rows = [ses(7), ses(8)]
    await show()
    await enterSelect('第 7 条')

    await click(boxOf('第 7 条'))
    expect(boxOf('第 7 条').checked).toBe(true)
    expect(texts()).toContain('已选 1 条')
    expect(btn('删除')!.disabled).toBe(false)

    await click(boxOf('第 7 条'))                  // 再点一下 = 取消
    expect(boxOf('第 7 条').checked).toBe(false)
    expect(texts()).toContain('已选 0 条')

    await click(rowOf('第 8 条')!.querySelector('.session-open'))   // 点行 = 勾
    expect(boxOf('第 8 条').checked).toBe(true)
    // ⚠️ 选择模式里点行**不许打开会话** —— 不然"勾一段"和"进去看看"抢同一个点击
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('「取消」退出选择模式：勾选框没了、「…」回来', async () => {
    rows = [ses(7)]
    await show()
    await enterSelect('第 7 条')
    await click(btn('取消'))

    expect(container.querySelectorAll('.session-pick')).toHaveLength(0)
    expect(container.querySelectorAll('.session-more')).toHaveLength(1)
    expect(texts()).not.toContain('已选')
  })

  it('点【删除】先问一句；「算了」什么都没变、勾还都在', async () => {
    rows = [ses(7), ses(8)]
    await show()
    await enterSelect('第 7 条')
    await click(rowOf('第 7 条')!.querySelector('.session-open'))
    await click(rowOf('第 8 条')!.querySelector('.session-open'))

    await click(btn('删除'))
    expect(texts()).toContain('删掉选中的 2 条？')
    expect(api.deleteSession).not.toHaveBeenCalled()

    await click(btn('算了'))
    expect(texts()).toContain('已选 2 条')          // 退回操作条、勾还在
    expect(boxOf('第 7 条').checked).toBe(true)
    expect(boxOf('第 8 条').checked).toBe(true)
  })

  it('★「确认删除」→ 勾的一起删：两段都发了请求、都喊了 onDeleted、删完退出选择模式', async () => {
    rows = [ses(7), ses(8)]
    await show()
    await enterSelect('第 7 条')
    await click(rowOf('第 7 条')!.querySelector('.session-open'))
    await click(rowOf('第 8 条')!.querySelector('.session-open'))

    await click(btn('删除'))
    await click(btn('确认删除'))

    expect(api.deleteSession).toHaveBeenCalledTimes(2)
    expect(api.deleteSession).toHaveBeenCalledWith(7)
    expect(api.deleteSession).toHaveBeenCalledWith(8)
    expect(rowOf('第 7 条')).toBeNull()
    expect(rowOf('第 8 条')).toBeNull()
    // 每删成功一条都要喊一声：删掉**正在改**的那条时，App 手上那份照片 / 对话 /
    // 快照全靠这一声跟着走（单条那条已有的一整套）。
    expect(onDeleted).toHaveBeenCalledWith(7)
    expect(onDeleted).toHaveBeenCalledWith(8)
    // 全删成功 → 选择模式自己收掉（留着一条"已选 0 条"的空条子才奇怪）
    expect(container.querySelector('.sessions-select')).toBeNull()
    expect(container.querySelectorAll('.session-pick')).toHaveLength(0)
  })

  it('★ 部分失败：没删掉的留在列表里、**还在勾里**，上面说一句 —— 直接再点一次就能重试', async () => {
    rows = [ses(7), ses(8)]
    await show()
    // 让 8 号删不掉（7 号照常）
    vi.mocked(api.deleteSession).mockImplementation(async (id) => {
      if (id === 8) throw new Error('没删掉，再试一次？')
      rows = (rows ?? []).filter((r) => r.id !== id)
    })
    await enterSelect('第 7 条')
    await click(rowOf('第 7 条')!.querySelector('.session-open'))
    await click(rowOf('第 8 条')!.querySelector('.session-open'))
    await click(btn('删除'))
    await click(btn('确认删除'))

    expect(rowOf('第 7 条')).toBeNull()            // 删掉的当场走人
    expect(rowOf('第 8 条')).not.toBeNull()        // 没删掉的**不许装作删掉了**
    expect(texts()).toContain('有 1 条没删掉')
    // 失败那条还勾着、还在选择模式里 —— 再点一次【删除】就是重试
    expect(boxOf('第 8 条').checked).toBe(true)
    expect(texts()).toContain('已选 1 条')
    // 那一声只喊**成功**的那条（喊错了 App 会把用户手上的活儿当别人的扔了）
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith(7)
  })
})

// ── 改名（2026-10-05）────────────────────────────────────────────────
//
// 手势和作品详情页那颗「改名」**是同一套**（回车 / 点走保存、Esc 取消），所以
// 每条都在钉那套手势：进编辑态预填什么、请求长什么形状、什么情况不发请求、
// 两条保存路径合起来只发一次。服务端那半（改名不动 `updated_at`，列表不跳
// 位置）在 `server/sessions.test.ts` 里。

describe('改名', () => {
  it('点「改名」→ 就地变输入框（预填当前名字）；回车保存，**请求只发一次**', async () => {
    rows = [ses(7)]
    await show()

    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement | null
    expect(box).toBeTruthy()             // 没进编辑态的话下面会崩得看不懂
    expect(box!.value).toBe('第 7 条')    // 预填的是**当前显示名**

    box!.value = '海边那张'
    await act(async () => {
      box!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })

    expect(names()).toEqual(['海边那张'])                 // 行上当场换名
    expect(container.querySelector('.session-rename')).toBeNull()   // 编辑态收掉了
    expect(renameCalls).toEqual([{ id: 7, patch: { title: '海边那张' } }])
    // ★ **请求只能发一次。** 两条保存路径（回车走 `onKeyDown`、点走别处走
    //   `onBlur`）都会调用 `doRename`；而回车会把输入框收掉 —— 输入框是在
    //   "有焦点"的状态下被卸载的，浏览器补不补 blur/focusout 各实现不一致。
    //   补了就是两次 PUT（第二次还用改名前的旧名字去比），这条断言把它变成
    //   当场可观察的。（作品详情页同款断言，见 App.test.tsx）
    expect(renameCalls).toHaveLength(1)
  })

  it('名字没变 → 一个字都不发（别拿一趟白请求去顶那一行的位置）', async () => {
    rows = [ses(7)]
    await show()
    await viaMenu('第 7 条', '改名')
    // 什么都不改，直接回车
    await act(async () => {
      container.querySelector('.session-rename')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })
    expect(renameCalls).toHaveLength(0)
    expect(names()).toEqual(['第 7 条'])
    expect(container.querySelector('.session-rename')).toBeNull()   // 但编辑态要收掉
  })

  it('Esc 取消：退出编辑态，名字原样', async () => {
    rows = [ses(7)]
    await show()
    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement
    box.value = '改了一半不想要了'
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await tick()
    })
    expect(container.querySelector('.session-rename')).toBeNull()
    expect(renameCalls).toHaveLength(0)
    expect(names()).toEqual(['第 7 条'])
  })

  it('★ 中文输入法**选词**的回车不算提交（isComposing）', async () => {
    // 不挡的话：用户打"海边"选词按回车 → 名字半截存成"海"，一声不吭 ——
    // 中文产品的改名框，这是主路径不是边角。
    rows = [ses(7)]
    await show()
    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement
    box.value = '海'
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
      await tick()
    })
    expect(renameCalls).toHaveLength(0)                                  // 没提交
    expect(container.querySelector('.session-rename')).not.toBeNull()    // 还在输入
  })

  it('★ 清空 = 回退到照片名（送空串，服务端存 null）', async () => {
    rows = [ses(7, { originalName: '海边.jpg' })]
    await show()
    // 先确认这条显示的是 title（「第 7 条」），不是照片名 —— 不然下面
    // "回退"两个字无从谈起
    expect(names()).toEqual(['第 7 条'])

    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement
    box.value = ''
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })

    expect(renameCalls).toEqual([{ id: 7, patch: { title: '' } }])   // 空串，不是 null
    expect(names()).toEqual(['海边'])     // 回退到照片名（去扩展名）
  })

  it('点走（blur）也保存 —— 和回车是同一套手势', async () => {
    rows = [ses(7)]
    await show()
    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement
    box.value = '海边那张'
    // ⚠️ React 17 起 `onBlur` 走的是原生的 **focusout**（它才冒泡），派 `blur`
    //   收不到（同一句话在 `kit/Slider.test.tsx` 里也写着）
    await act(async () => {
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await tick()
    })
    expect(renameCalls).toEqual([{ id: 7, patch: { title: '海边那张' } }])
    expect(names()).toEqual(['海边那张'])
  })

  it('改失败：列表和那一行原样不动，只在上面加一句"没改成"', async () => {
    rows = [ses(7)]
    renameFail = new Error('没改成，再试一次')
    await show()
    await viaMenu('第 7 条', '改名')
    const box = container.querySelector('.session-rename') as HTMLInputElement
    box.value = '新名字'
    await act(async () => {
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await tick()
    })

    expect(texts()).toContain('没改成')
    expect(rowOf('第 7 条')).not.toBeNull()   // 名字没变、行还在
    expect(container.querySelector('.sessions-empty-title')).toBeNull()
    // 编辑态已经收了 —— 要重试就再点一次「改名」（和作品详情页一样，
    // 失败不自动弹回编辑框，免得用户以为"还没提交出去"）
    expect(container.querySelector('.session-rename')).toBeNull()
  })
})
