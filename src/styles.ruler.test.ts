/**
 * 表现层「尺子」的常驻守卫（★ 2026-10-07「完成度升级」，spec §2/§3）。
 *
 * 字号、字重、图标线宽这几样**没有任何测试量得到**（jsdom 不算样式，
 * check:layout 只量盒子）——这批守卫用字符串哨兵读 CSS/TSX 源文件，
 * 把"尺子"钉在源码层。仓库先例：CompareSplit.test.tsx 读 styles.css。
 *
 * ⚠️ 守卫的边界：只查**显式写出来的**值。往图标上加 `strokeWidth` 时记得
 * 显式写 `{1.5}`（lucide 的默认值是 2，不写就绕过了这一条）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')
const landing = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8')

const APP_SIZES = new Set(['12', '13', '14', '15', '17', '20', '22', '26', '30'])
const LANDING_SIZES = new Set(['14', '15', '16', '17', '20'])

describe('尺子守卫 · 字号', () => {
  it('app 的 font-size 只许 9 档', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1])
    const bad = [...new Set(sizes.filter((s) => !APP_SIZES.has(s)))]
    expect(bad, `styles.css 里出现了阶梯外字号: ${bad.join(', ')}`).toEqual([])
  })
  it('门面的 font-size 只许 5 档', () => {
    const sizes = [...landing.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1])
    const bad = [...new Set(sizes.filter((s) => !LANDING_SIZES.has(s)))]
    expect(bad, `landing.css 里出现了阶梯外字号: ${bad.join(', ')}`).toEqual([])
  })
})

describe('尺子守卫 · 字重', () => {
  it('app 只许 400 / 600', () => {
    const ws = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1])
    const bad = [...new Set(ws.filter((w) => w !== '400' && w !== '600'))]
    expect(bad, `styles.css 里出现了第三档字重: ${bad.join(', ')}`).toEqual([])
  })
})

describe('尺子守卫 · 图标线宽', () => {
  it('src/ui 下所有显式 strokeWidth 只许 1.5', () => {
    const bad: string[] = []
    const uiDir = fileURLToPath(new URL('./ui', import.meta.url))
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/strokeWidth=\{?([\d.]+)\}?/g)) {
          if (m[1] !== '1.5') bad.push(`${relative(uiDir, p)}: strokeWidth=${m[1]}`)
        }
      }
    }
    walk(uiDir)
    expect(bad, `线宽不统一: ${bad.join(' / ')}`).toEqual([])
  })
})
