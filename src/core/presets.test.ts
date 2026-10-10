import { describe, it, expect } from 'vitest'
import { PRESETS, ORIGINAL_ID, activePresetId, type Preset } from './presets'
import { PARAM_KEYS, PARAM_RANGE, ZERO } from '../../shared/adjustments.ts'

describe('PRESETS', () => {
  // ★ 2026-10-05：从 6 个扩到 12 个 —— 预设从"面板上一排文字药丸"变成
  //   照片左边那条「一格一张实拍效果小图」的预设栏（用户要的"像剪映一样"）。
  //   条数从"至少 5"提到"至少 12"：那条栏一屏能摆下十来个，六个撑不满。
  it('至少 12 个预设', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(12)
  })

  /**
   * ★ 2026-10-05：老的六个**一个都不许丢**。
   *
   * 它们从 2026-09-21 就在了，是用户点过、认得出的那六个名字 ——
   * 这一轮是"往这条栏里加新的"，不是"换一批"。有人在整理 id 时顺手删掉一个，
   * 用户看到的是"我常用的那个不见了"，而这不会以任何别的方式报出来。
   */
  it('老的六个预设一个都不能少', () => {
    const ids = PRESETS.map(p => p.id)
    for (const old of ['jp-clean', 'film', 'golden', 'bright', 'moody', 'vivid']) {
      expect(ids, `老预设 ${old} 不见了`).toContain(old)
    }
  })

  it('id 唯一', () => {
    const ids = PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * ★ 2026-10-10（「我的预设」）：**id 空间的约定** —— 内置 id 全是非纯数字串，
   * 服务端预设的数字 id 一律 `String(id)` 拼进同一个空间，两边永远撞不上。
   * 哪天有人给内置预设起名 `'5'`，用户那套 id=5 的预设就会冒名点亮它 ——
   * 而那不会以任何别的方式报出来。
   */
  it('内置 id 全是非纯数字串（服务端预设 String(id) 拼进来不会撞）', () => {
    expect(ORIGINAL_ID).not.toMatch(/^\d+$/)
    for (const p of PRESETS) expect(p.id, `${p.label} 的 id 是纯数字`).not.toMatch(/^\d+$/)
  })

  it('每个预设都有中文标签', () => {
    for (const p of PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.label).toMatch(/[一-龥]/)
    }
  })

  it('每个预设的每个字段都是数，且都落在**它自己那条**的范围里（条数不写死 —— 表里有几根就查几根）', () => {
    for (const p of PRESETS) {
      for (const k of PARAM_KEYS) {
        expect(typeof p.adjustments[k], `${p.id}.${k} 不是数`).toBe('number')
        // ★ 2026-10-04 终审勘误：原来两条硬编码的 ±100 —— 色相（0~360）和
        // 强度（0~100）本来就不在 [-100, 100] 里，这条断言对那三根是**错的**
        // （当下全 0 所以绿着）。改成按 `PARAM_RANGE` 各自核：范围表改了它跟着走。
        const [lo, hi] = PARAM_RANGE[k]
        expect(p.adjustments[k], `${p.id}.${k} 低于下界`).toBeGreaterThanOrEqual(lo)
        expect(p.adjustments[k], `${p.id}.${k} 高于上界`).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('预设之间不是完全相同的', () => {
    const seen = new Set(PRESETS.map(p => JSON.stringify(p.adjustments)))
    expect(seen.size).toBe(PRESETS.length)
  })

  /**
   * ★ 2026-10-05：「全零」是一个预设**够不着**的状态 —— 它已经被「原图」那一格占了。
   *
   * `activePresetId` 先判"全零"再去找匹配，所以一个全零的预设**永远点不亮**
   * （用户点了它，亮的是「原图」）。这不会以任何别的方式报出来。
   */
  it('没有哪个预设是"什么都没做"（那一格留给「原图」）', () => {
    for (const p of PRESETS) {
      expect(PARAM_KEYS.some(k => p.adjustments[k] !== 0), `${p.id} 是全零的`).toBe(true)
    }
  })
})

/**
 * 「现在正套着哪一个」—— 预设栏靠它点亮那一格（★ 2026-10-05）。
 *
 * 判据是**全等**：用户拖了任何一根滑块之后就不该再亮着 —— 那一眼看到的东西
 * 已经不是那个预设了。所以这里没有"接近"这回事，差一个数就是不亮。
 */
describe('activePresetId', () => {
  it('全零 + 没挂滤镜 = 「原图」', () => {
    expect(activePresetId(ZERO, false)).toBe(ORIGINAL_ID)
  })

  it('参数和某个预设全等 + 没挂滤镜 = 那个预设', () => {
    const p = PRESETS[2]!
    expect(activePresetId({ ...p.adjustments }, false)).toBe(p.id)
  })

  it('差一个数就不算（拖过滑块之后不该再亮着）', () => {
    const p = PRESETS[2]!.adjustments
    expect(activePresetId({ ...p, exposure: p.exposure + 1 }, false)).toBeNull()
  })

  /**
   * ★ 挂着滤镜时**谁都不点亮** —— 包括「原图」。
   *
   * 亮着「原图」而画面明显有滤镜，是这个小控件最容易说的一句假话；
   * 亮着某个预设也不对：那时候画面是"预设 + 滤镜"，不是那个预设。
   * 摘掉滤镜之后它会自己亮回来（参数一个字没动，见上面那条全等判据）。
   */
  it('挂着滤镜时谁都不点亮（原图也不）', () => {
    expect(activePresetId({ ...PRESETS[0]!.adjustments }, true)).toBeNull()
    expect(activePresetId(ZERO, true)).toBeNull()
  })

  /**
   * ★ 2026-10-10（「我的预设」）：第三个参数 = **自己存的那份清单** ——
   * 全等匹配的范围从"内置那十二个"扩成"内置 + 我的"（预设栏两段共用这一份判据）。
   */
  const MINE: readonly Preset[] = [
    { id: '501', label: '黄昏旅拍', adjustments: { ...ZERO, exposure: 33, temperature: 20 } },
  ]

  it('我的那套全等 = 亮它；内置那十二个照样算（同一份清单里找）', () => {
    expect(activePresetId({ ...MINE[0]!.adjustments }, false, MINE)).toBe('501')
    const p = PRESETS[2]!
    expect(activePresetId({ ...p.adjustments }, false, MINE)).toBe(p.id)
  })

  it('我的这套差一个数也不亮（同一把全等尺子，没有"接近"）', () => {
    expect(activePresetId({ ...MINE[0]!.adjustments, exposure: 34 }, false, MINE)).toBeNull()
  })

  it('不给清单（旧调用）时我的那套不算数 —— 默认值保住旧行为', () => {
    expect(activePresetId({ ...MINE[0]!.adjustments }, false)).toBeNull()
  })
})
