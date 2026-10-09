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

describe('尺子守卫 · 影子令牌不许被 light-dark() 整条包住', () => {
  /**
   * ★ 2026-10-09：**这一条是我自己栽出来的。**
   *
   * `light-dark()` 只对 `<color>` 有效。给影子写
   * `--photo-shadow: light-dark(0 4px 14px rgba(…), 0 4px 14px rgba(…))` 时，
   * 它替换进 `box-shadow` 得到的是**无效值** —— 于是**整条声明被判无效、
   * 退回 `none`**：照片一点影子都没有了。
   *
   * ⚠️ 这种坏法**四样检查全瞎**：单测不算样式、typecheck 不看 CSS、
   *    build 不看 CSS、`check:layout` 只量盒子 —— 而"照片没有影子"和
   *    "照片有一道很小的影子"**在盒子上完全一样**。用户看到的是"还是没变化"
   *    （他其实什么都没看出来，因为影子**整条消失**了）。
   *    只有真机上的 `getComputedStyle(canvas).boxShadow` 会回你一个 `none`。
   *
   * 正确写法是**只包颜色那一段**（`--shadow-1/2/3` 一直是这么写的）：
   *   `--x-shadow: 0 4px 14px light-dark(rgba(…), rgba(…))`
   */
  it('任何 `--*shadow*` 令牌都不许以 `light-dark(` 开头', () => {
    const bad = [...css.matchAll(/(--[\w-]*shadow[\w-]*)\s*:\s*(light-dark\()/g)]
      .map((m) => m[1])
    expect(bad, `这些影子令牌把整条影子包进了 light-dark()（会静默变成 none）: ${bad.join(', ')}`)
      .toEqual([])
  })
})

describe('尺子守卫 · 注释块必须闭合（闭合了才有"整站白屏"这一档）', () => {
  /**
   * ★ 2026-10-09：**这一条是同一天连着栽两次之后补的。**
   *
   * postcss 遇到没闭合（或者被提前关掉）的块注释时**直接抛**，而它是 vite 编译
   * CSS 的那一步 —— 后果不是"某条样式没生效"，是 **`styles.css` 整份编不出来、
   * 页面白屏**（连 `.shell` 都不渲染，浏览器上就是一片空白）。
   *
   * 两次都是我自己写的：
   *   ① 把一段说明写在了注释块的**收尾标记外面**（那段文字裸露在声明区）；
   *   ② 修①的时候，又在注释**正文里写出了那个收尾标记本身** —— 注释当场被关掉。
   *
   * ⚠️ 现有的四样**全都能过**：`npm test` 不算样式（这条守卫就是补它）、
   *    typecheck / build 不看 CSS 的括号（build 其实会红，但没人跑）、
   *    `check:layout` 会红 —— 可它要开浏览器、几分钟，不是每次都会跑。
   * 所以补一条**六行的字符串对账**：CSS 里不许有嵌套注释，`/*` 和它反向的那个
   * 标记必须**一样多**。
   */
  it('styles.css 的 `/*` 和收尾标记一样多', () => {
    const open = (css.match(/\/\*/g) ?? []).length
    const close = (css.match(/\*\//g) ?? []).length
    expect(open, `块注释的收尾标记比开头多/少了（CSS 编不过 = 整站白屏）`)
      .toBe(close)
  })
})

describe('尺子守卫 · 隐藏字重', () => {  it('用了 <b>/<strong> 就必须压住浏览器默认的 700', () => {
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
