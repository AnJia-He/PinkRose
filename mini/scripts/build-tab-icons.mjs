/**
 * tabBar 图标出图（Task 16）：3 个源 SVG（tab-icons/*.svg）→ 6 张 81×81 透明底 PNG
 * （mini/assets/tab/{edit,works,me}{,-on}.png）。
 *
 * 出图办法照 logo 那条管线（.superpowers/scratch/logo-cat/build-mini-badge.mjs）：
 * Playwright + 系统 Edge 渲染内联 SVG，omitBackground 保透明底。
 *
 * 跑法（在仓库根目录）：node mini/scripts/build-tab-icons.mjs
 * （playwright 用的是桌面项目 node_modules 里那份；mini/ 自己不带依赖）
 *
 * ⚠️ 两个颜色 = app.json tabBar 的 color / selectedColor 手抄，与 app.wxss 令牌同源：
 *    未选中 #b9b9c3 = --muted / 选中 #2dd4bf = --accent-400。改令牌时三处（app.json /
 *    app.wxss / 这里）一起看。⚠️ 81×81 是微信 tabBar 图标的推荐尺寸；每张 ≤40KB。
 */
import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const MINI = join(SCRIPT_DIR, '..')
const SRC = join(SCRIPT_DIR, 'tab-icons')
const OUT = join(MINI, 'assets', 'tab')
const SIZE = 81
const COLOR_OFF = '#b9b9c3' // = app.wxss --muted / app.json tabBar.color
const COLOR_ON = '#2dd4bf' // = app.wxss --accent-400 / app.json tabBar.selectedColor

const ICONS = ['edit', 'works', 'me']
const VARIANTS = [
  ['', COLOR_OFF],
  ['-on', COLOR_ON],
]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } })

for (const name of ICONS) {
  const svg = readFileSync(join(SRC, name + '.svg'), 'utf8')
  for (const [suffix, color] of VARIANTS) {
    const filled = svg.replaceAll('currentColor', color)
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${filled}`
    )
    const out = join(OUT, name + suffix + '.png')
    await page.screenshot({ path: out, omitBackground: true })
    const kb = (statSync(out).size / 1024).toFixed(1)
    console.log(`${name}${suffix}.png  ${kb}KB`)
  }
}

await browser.close()
console.log('DONE →', OUT)
