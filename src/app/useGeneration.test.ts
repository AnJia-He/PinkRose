// @vitest-environment jsdom
/**
 * ★ 2026-10-10：忙气泡那句话的**秒表**（纯函数，UI 那半在 App.test.tsx）。
 *
 * 为什么值得一个单测：这句话的规则全是分支（哪一段文案、5 秒前 / 5 秒后），
 * 而 App 级那条真等 5 秒的用例**只走得动一条分支**（生成那句）。剩下的分支
 * 在这里逐条钉住 —— 比如「正在思考…」这种没有时间部分的句子，5 秒后是
 * **追加**而不是替换，写错的话只有路由真慢到 5 秒时才有人看见。
 */
import { describe, expect, it } from 'vitest'
import { BUSY_GENERATING, busyText } from './useGeneration'

describe('★ 忙气泡的秒表（2026-10-10）', () => {
  it('5 秒内照原句 —— 生成那句自带「大约 10 秒」的预期', () => {
    expect(busyText(BUSY_GENERATING, 0)).toBe('正在改…大约 10 秒')
    expect(busyText(BUSY_GENERATING, 4)).toBe('正在改…大约 10 秒')
    expect(busyText('正在思考…', 0)).toBe('正在思考…')
    expect(busyText('正在思考…', 4)).toBe('正在思考…')
  })

  it('5 秒起换成真实经过的秒数 —— 写死的「大约 10 秒」过了点就开始骗人', () => {
    // ⚠️ 生成那句是**替换**（"大约 10 秒"和真实秒数不能同屏，两个时间会打架）
    expect(busyText(BUSY_GENERATING, 5)).toBe('正在改…已经等了 5 秒')
    expect(busyText(BUSY_GENERATING, 21)).toBe('正在改…已经等了 21 秒')
  })

  it('没有时间部分的忙句是**追加** —— 秒数对所有等待段都长出来', () => {
    expect(busyText('正在思考…', 6)).toBe('正在思考…已经等了 6 秒')
    expect(busyText('正在打开照片…', 8)).toBe('正在打开照片…已经等了 8 秒')
    expect(busyText('正在打开这条对话…', 12)).toBe('正在打开这条对话…已经等了 12 秒')
  })

  it('常量本身一个字没动 —— 它是"这一段是不是真生成"的身份判据，不少地方在比它', () => {
    // 这条看着像废话，守的是另一件事：有人把常量值改短（比如改成 '正在改…'）
    // 来"顺手"支持秒表 —— 那样 App 的 `busy === BUSY_GENERATING` 照样成立，
    // 但所有把这句话当文案的注释、探针脚本、dump-copy 就全对不上了。
    // 秒表的实现（busyText）是**另起一层**，常量不动。
    expect(BUSY_GENERATING).toBe('正在改…大约 10 秒')
  })
})
