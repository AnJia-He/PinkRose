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
/** 手动放行的"还没回来"那一瞬间用 */
let holdList: (() => void) | null

let container: HTMLElement
let root: Root
let onOpen: ReturnType<typeof vi.fn>
let onNew: ReturnType<typeof vi.fn>

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

  vi.mocked(api.listSessions).mockImplementation(() => {
    if (holdList) return new Promise((resolve) => { holdList = () => resolve(rows ?? []) })
    if (listFailed) return Promise.reject(listFailed)
    return Promise.resolve(rows ?? [])
  })
  vi.mocked(api.deleteSession).mockImplementation(async (id) => {
    if (deleteFailed) throw deleteFailed
    rows = (rows ?? []).filter((r) => r.id !== id)
  })

  onOpen = vi.fn()
  onNew = vi.fn()
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
    root.render(<SessionsPage onOpen={onOpen} onNew={onNew} />)
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

    await click(inPart(rowOf('第 7 条')!, '删除'))
    // 问在**原处**：那一行里冒出「删掉这条？」，而不是浏览器那个模态框
    expect(texts()).toContain('删掉这条？')
    expect(confirmSpy).not.toHaveBeenCalled()
    // 还没答话，谁也不许删
    expect(api.deleteSession).not.toHaveBeenCalled()

    // 「取消」= 什么都没发生
    await click(inPart(rowOf('第 7 条')!, '取消'))
    expect(texts()).not.toContain('删掉这条？')
    expect(rowOf('第 7 条')).not.toBeNull()

    // 再来一次，这回认了
    await click(inPart(rowOf('第 7 条')!, '删除'))
    await click(inPart(rowOf('第 7 条')!, '删掉'))
    expect(api.deleteSession).toHaveBeenCalledWith(7)
    // 那一行当场走人（等下次刷新才消失的话，用户会以为没删掉）
    expect(rowOf('第 7 条')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
    // 变异：改用 `window.confirm` → 第一条 not.toHaveBeenCalled 红；
    // 删完不动本地名单 → 最后那条 toBeNull 红。
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
      root.render(<SessionsPage onOpen={onOpen} onNew={onNew} />)
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

    await click(inPart(rowOf('那条删不掉的')!, '删除'))
    await click(inPart(rowOf('那条删不掉的')!, '删掉'))

    expect(api.deleteSession).toHaveBeenCalledWith(7)
    expect(rowOf('那条删不掉的')).not.toBeNull()   // 没删掉就是没删掉，别装作删掉了
    expect(texts()).toContain('没删掉')
    expect(container.querySelector('.sessions')).not.toBeNull()
    expect(container.querySelector('.sessions-empty-title')).toBeNull()
    // 变异：删失败也往 `failed` 那个状态上写 → 最后两条红。
  })
})
