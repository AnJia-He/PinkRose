import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * ⚠️ 这个文件只有一条测试，而且它**不调用那个函数** —— 它读源码。
 *
 * 为什么：`prepareForRouting` 要真画布（jsdom 里没有），行为测不了。
 * 而它那个默认值 **640 是量出来的**（2026-09-30 跑了三十来次真实调用：
 * 1024 的首块中位数 9.5s、640 是 5.2s；而路由结论两边一致）。
 *
 * 这种"花了几十次调用换来的一个数字"**最容易被下一个人顺手改回去** ——
 * 他看到的只是一个不起眼的默认参数。所以在这里留一颗钉子：要改它，
 * 就得先改这条测试，也就先读到 `prepare.ts` 里那段理由和量法。
 *
 * （同样的做法在 `shared/adjustments.test.ts` 里有一条 —— 那条也是读源码，
 *  钉的是"两个消费方都得用同一个判据"。）
 */
describe('路由预览的尺寸', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'prepare.ts'), 'utf8')

  it('★ 默认不许超过 640 —— 这个数是量出来的，别顺手改回去', () => {
    const m = src.match(/prepareForRouting\([\s\S]{0,300}?maxDim\s*=\s*(\d+)/)
    expect(m, '没找到 prepareForRouting 的默认值（签名改了？这条判据要跟着改）').toBeTruthy()
    expect(Number(m![1])).toBeLessThanOrEqual(640)
  })
})
