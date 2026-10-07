/**
 * 表现层「尺子」的常驻守卫（★ 2026-10-07「完成度升级」，spec §2/§3）。
 *
 * 字号、字重、图标线宽这几样**没有任何测试量得到**（jsdom 不算样式，
 * check:layout 只量盒子）——这批守卫用字符串哨兵读 CSS/TSX 源文件，
 * 把"尺子"钉在源码层。仓库先例：CompareSplit.test.tsx 读 styles.css。
 *
 * ⚠️ 守卫的边界：只查**显式写出来的**值。往图标上加 `strokeWidth` 时记得
 * 显式写 `{1.5}`（lucide 的默认值是 2，不写就绕过了这一条）。
 *
 * ★ 2026-10-07（评审后补盲）：上面这条"不写就绕过"**真的发生了** ——
 * 全站 24 个图标里有 13 个没写 `strokeWidth`，一直在按 lucide 默认的 **2**
 * 渲染（同一个「＋」在对话栏是 1.5、在画布上是 2），而下面那条"显式值只许 1.5"
 * 一条都没红。同类的还有 `<b>`：浏览器默认 700，`font-weight` 那条守卫
 * 扫的是 CSS，看不见 TSX 里的标签。现在两条新判据把这两个洞堵上：
 * 只认"**每个图标都必须显式写**"，不再只查"写了的那个值对不对"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * ★ 2026-10-07：**先剥掉注释再数**。
 * 这几条守卫是拿正则扫源码的，而注释里也会出现 `font-weight: 150 700`
 * 这种"在解释字体"的句子 —— 那天它真的把一句注释当成了第三条字重，报出来的
 * 红看着像代码坏了，其实只是那行字。（同一个毛病在图标那条也成立：
 * 注释里写个 `<Plus size={15} />` 会被当成真用了这个图标。）
 * 剥的是 `/* … *\/` 整块；`//` 行注释不动 —— 那会误伤字符串里的 `//`（网址）。
 */
function stripBlockComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = stripBlockComments(readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8'))
const landing = stripBlockComments(readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8'))

const APP_SIZES = new Set(['12', '13', '14', '15', '17', '20', '22', '26', '30'])
const LANDING_SIZES = new Set(['14', '15', '16', '17', '20'])

/** `src/ui` 目录本身（新判据要给报错信息里的相对路径用）。 */
function uiDir() {
  return fileURLToPath(new URL('./ui', import.meta.url))
}

/** 走一遍 `src/ui` 下的非测试 tsx，把每个文件交出来。 */
function uiTsxFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue
      out.push(p)
    }
  }
  walk(uiDir())
  return out
}

/** 剥注释但**保住行号**（多行注释换成等量空白行）—— 报错要指到对的行上。 */
function stripCommentsKeepLines(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 读一个 `src/ui` 下的 tsx（已剥注释）。 */
function readUiTsx(p: string) {
  return stripCommentsKeepLines(readFileSync(p, 'utf8'))
}

/** 逐行走一遍 `src/ui` 下的非测试 tsx。 */
function eachUiTsx(fn: (path: string, line: string, lineNo: number) => void) {
  for (const p of uiTsxFiles()) {
    readUiTsx(p).split('\n').forEach((line, i) => fn(relative(uiDir(), p), line, i + 1))
  }
}

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
    eachUiTsx((p, line) => {
      for (const m of line.matchAll(/strokeWidth=\{?([\d.]+)\}?/g)) {
        if (m[1] !== '1.5') bad.push(`${p}: strokeWidth=${m[1]}`)
      }
    })
    expect(bad, `线宽不统一: ${bad.join(' / ')}`).toEqual([])
  })

  it('每个 lucide 图标都必须显式写 strokeWidth（不写 = 默认 2，绕过上一档）', () => {
    const bad: string[] = []
    for (const p of uiTsxFiles()) {
      const src = readUiTsx(p)
      const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)
      if (!imp) continue
      const names = imp[1]
        .split(',').map((s) => s.trim().split(' as ').pop()!.trim()).filter(Boolean)
      src.split('\n').forEach((line, i) => {
        for (const n of names) {
          for (const m of line.matchAll(new RegExp(`<${n}(\\s[^>]*?)?/?>`, 'g'))) {
            if (!(m[1] ?? '').includes('strokeWidth')) {
              bad.push(`${relative(uiDir(), p)}:${i + 1} <${n}> 没写 strokeWidth`)
            }
          }
        }
      })
    }
    expect(bad, `图标线宽没写全（lucide 默认是 2）: ${bad.join(' / ')}`).toEqual([])
  })
})

describe('尺子守卫 · 隐藏字重', () => {
  it('用了 <b>/<strong> 就必须压住浏览器默认的 700', () => {
    // `<b>` / `<strong>` 的粗体**不住在 CSS 里**，是浏览器的默认表现 ——
    // 字重那条守卫扫 CSS，扫不到它。用过就必须有一条规则把它收到 600。
    let used: string | null = null
    eachUiTsx((p, line, n) => {
      if (!used && /<(b|strong)[\s>]/.test(line)) used = `${p}:${n}`
    })
    if (used) {
      expect(css, `src/ui 用了 <b>/<strong>（${used}），但 styles.css 没有把它们的字重收到 600`)
        .toMatch(/b,\s*strong\s*\{[^}]*font-weight:\s*600/)
    }
  })
})
