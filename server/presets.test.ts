import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDb, type Db } from './db.ts'
import { createPreset, deletePreset, listPresets, renamePreset } from './presets.ts'
import { HttpError } from './http.ts'
import { PARAM_KEYS, ZERO } from '../shared/adjustments.ts'
import { MAX_PRESETS, MAX_PRESET_NAME } from '../shared/preset.ts'
import { PRESET_LIMIT_REACHED } from '../shared/copy.ts'
import type { PublicUser } from './account.ts'

const user: PublicUser = { id: 1, username: 'a', email: 'a@b.c' }
/** 另一个人 —— 用来验"别人的预设看不见、也删不掉" */
const other: PublicUser = { id: 2, username: 'b', email: 'b@b.c' }

let db: Db
/** 钟拿在手里：`createdAt` 和倒序都靠它，别依赖真时间的毫秒先后 */
let clock: { t: number }
let deps: { db: Db; now: () => number }

beforeEach(() => {
  db = openDb(':memory:')
  db.raw.exec(`INSERT INTO users (username, email, password_hash, created_at)
               VALUES ('a','a@b.c','x',0), ('b','b@b.c','x',0)`)
  clock = { t: 1000 }
  deps = { db, now: () => clock.t }
})
afterEach(() => { db.close() })

/**
 * 接住同步抛出来的那个 `HttpError` —— 有些断言要**同时**看 message 和 status。
 *
 * ⚠️ 不用 `toThrow('…')`（那是"包含"），也不比裸 message：`new HttpError(code, msg)`
 * 少传第三个参数时 status 是 400，而"404 那条闸掉了、回 400"这种坏法
 * 只看 message 是看不出来的。
 */
function httpErrorOf(fn: () => unknown): HttpError {
  try { fn() } catch (e) { if (e instanceof HttpError) return e; throw e }
  throw new Error('这一下本该抛，却没抛')
}

describe('预设 CRUD', () => {
  it('存一套 → 列出来（按创建时间倒序）', () => {
    clock.t = 1000
    const { preset } = createPreset({ name: '黄昏', params: { exposure: 30, contrast: -20 } }, user, deps)
    clock.t = 2000
    createPreset({ name: '清透', params: { exposure: -10 } }, user, deps)

    const { presets } = listPresets(user, deps)
    expect(presets.map((p) => p.name)).toEqual(['清透', '黄昏'])   // 后存的在前
    // params 原样回：存进去的那几格还在，没送的那几格是 0（永远是完整一套）
    expect(presets[1]!.params).toEqual({ ...ZERO, exposure: 30, contrast: -20 })
    expect(presets[1]!.id).toBe(preset.id)
    expect(presets[1]!.createdAt).toBe(1000)   // `nowMs(deps)` —— 用的就是手里这个钟
  })

  it('名字重复（忽略大小写）不许存 —— 存和改名两处同一个判据', () => {
    createPreset({ name: 'Sunset', params: {} }, user, deps)
    // 大小写不同 = 同一个名字（库里那一列是 `COLLATE NOCASE`，查重走的就是它）
    expect(() => createPreset({ name: 'sunset', params: {} }, user, deps)).toThrow(/换个名字/)
    // 首尾空格不同 = 同一个名字（入库前 trim）
    expect(() => createPreset({ name: ' Sunset ', params: {} }, user, deps)).toThrow(/换个名字/)
    // 那句话逐字钉住（用户看得见的文案）
    expect(httpErrorOf(() => createPreset({ name: 'sunset', params: {} }, user, deps)).message)
      .toBe('已经有一套叫「sunset」的预设了，换个名字。')

    // 改名那处**同一个判据**：把另一套改成已经被占用的名字 → 也 400
    const { preset } = createPreset({ name: '黄昏', params: {} }, user, deps)
    expect(() => renamePreset(preset.id, { name: 'Sunset' }, user, deps)).toThrow(/换个名字/)
    // 拒绝了之后库里那两套一个字节没动（别把半截改动留下）
    expect(listPresets(user, deps).presets.map((p) => p.name)).toEqual(['黄昏', 'Sunset'])
  })

  it('参数会被钳制：越界的数字入库前收进合法范围', () => {
    // 客户端送什么都得当"可以伪造的输入"：`clampAdjustments` 逐格钳到
    // `PARAM_RANGE`，没送的键补 0（undefined 不是有限数，走的就是那条路）。
    const { preset } = createPreset(
      { name: '黄昏', params: { exposure: 999, splitHiHue: 9999 } }, user, deps)
    expect(preset.params.exposure).toBe(100)      // 上限 100
    expect(preset.params.splitHiHue).toBe(360)    // 色相那三格是 0–360，不是 ±100
    expect(preset.params.contrast).toBe(0)        // 没送的键 = 中立
    // 完整 15 格：少一格的话，前端整套赋值那一步会把 undefined 塞进滑块里
    expect(Object.keys(preset.params).sort()).toEqual([...PARAM_KEYS].sort())
    // 进库的也是钳过的那份（不是"存原文、读的时候再钳"）
    expect(listPresets(user, deps).presets[0]!.params.exposure).toBe(100)
  })

  it(`上限 ${MAX_PRESETS}：满了再存 → 400，且用的是共享那句文案`, () => {
    for (let i = 0; i < MAX_PRESETS; i++) createPreset({ name: `p${i}`, params: {} }, user, deps)
    const e = httpErrorOf(() => createPreset({ name: 'one-more', params: {} }, user, deps))
    // 逐字比**共享的那句**（`shared/copy.ts`）—— 在这里另写一句自己的话，这条红
    expect(e.status).toBe(400)
    expect(e.message).toBe(PRESET_LIMIT_REACHED(MAX_PRESETS))
    expect(listPresets(user, deps).presets).toHaveLength(MAX_PRESETS)
  })

  it('改名：改成别人的名字 400；改成自己的同一名字（同名跳过查重）OK', () => {
    const { preset } = createPreset({ name: '黄昏', params: { exposure: 30 } }, user, deps)
    createPreset({ name: '清透', params: {} }, user, deps)

    // 真改名：换一个新名字 → 成功，参数原样跟着（改名不该动那一列）
    const renamed = renamePreset(preset.id, { name: '晨光' }, user, deps).preset
    expect(renamed.name).toBe('晨光')
    expect(renamed.params.exposure).toBe(30)

    // 改成别人的名字 → 400
    expect(() => renamePreset(preset.id, { name: '清透' }, user, deps)).toThrow(/换个名字/)

    // 改成自己现在这个名字 → OK（`name !== row.name` 那道跳过查重）——
    // "什么都没改"是合法输入，不该逼用户先换个别的名字再换回来
    expect(renamePreset(preset.id, { name: '晨光' }, user, deps).preset.name).toBe('晨光')
  })

  it('删：删掉之后列表里没有；删别人的 / 不存在的 → 404（同一句话）', () => {
    const mine = createPreset({ name: '黄昏', params: {} }, user, deps).preset
    const theirs = createPreset({ name: '别人的', params: {} }, other, deps).preset

    deletePreset(mine.id, user, deps)
    expect(listPresets(user, deps).presets).toHaveLength(0)
    // 别人那一套没被碰
    expect(listPresets(other, deps).presets).toHaveLength(1)

    // 不是他的 / 不存在：**同一句话**（分开说就等于告诉别人哪些 id 是真的）
    const a = httpErrorOf(() => deletePreset(theirs.id, user, deps))
    const b = httpErrorOf(() => deletePreset(999999, user, deps))
    expect(a.status).toBe(404)
    expect(a.message).toBe('没有这套预设')
    expect(b.status).toBe(404)
    expect(b.message).toBe(a.message)
  })

  it('名字 0 字 / 31 字 → 400', () => {
    expect(httpErrorOf(() => createPreset({ name: '', params: {} }, user, deps)).message)
      .toBe(`预设名字要 1–${MAX_PRESET_NAME} 个字。`)
    expect(() => createPreset({ name: '   ', params: {} }, user, deps)).toThrow(/名字/)   // trim 之后是 0 字
    expect(() => createPreset({ name: 'x'.repeat(MAX_PRESET_NAME + 1), params: {} }, user, deps))
      .toThrow(/名字/)
    // 正好 30 字是合法的 —— 边界两边都钉住，不然"一律拒绝"也能绿
    expect(createPreset({ name: 'x'.repeat(MAX_PRESET_NAME), params: {} }, user, deps).preset.name)
      .toBe('x'.repeat(MAX_PRESET_NAME))
    expect(listPresets(user, deps).presets).toHaveLength(1)

    // 改名那处**同一把尺子**：空名字也 400
    const { preset } = createPreset({ name: '黄昏', params: {} }, user, deps)
    expect(() => renamePreset(preset.id, { name: ' ' }, user, deps)).toThrow(/名字/)
  })

  it('★ 库里那列参数坏了 → 500，不是静默给一份空参数', () => {
    // 把 params 改成坏 JSON（正常写入路径写不进这种值，这是"库里坏了"的现场）。
    // ⚠️ 静默回全零的话，用户看到的是"我存的那套颜色全归零了" ——
    //    真正的原因一声不吭地没了，正是这个项目最恨的那种坏法。
    const { preset } = createPreset({ name: '黄昏', params: { exposure: 30 } }, user, deps)
    db.raw.prepare('UPDATE presets SET params = ? WHERE id = ?').run('{不是 JSON', preset.id)
    // 细节只进服务端日志 —— 打桩一下，别弄脏测试输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const e = httpErrorOf(() => listPresets(user, deps))
      expect(e.status).toBe(500)
      expect(e.code).toBe('INTERNAL')
      // 现场确实被记下来了（不然用户那边只剩一句"出了点问题"，我们也查不出是哪条）
      expect(String(spy.mock.calls.flat().join(' '))).toContain('预设')
    } finally { spy.mockRestore() }
  })
})
