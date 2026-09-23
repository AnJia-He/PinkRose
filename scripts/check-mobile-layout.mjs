/**
 * 检查：手机屏幕上，照片看得见吗？
 *
 * 为什么需要单独一条 —— **现有四样检查天生看不见这类 bug**：
 *
 * | 检查 | 为什么看不见 |
 * |---|---|
 * | 227 条测试 | jsdom **没有排版引擎**，getBoundingClientRect() 一律返回 0 |
 * | typecheck | 不看 CSS |
 * | vite build | 不看 CSS |
 * | check-dev-urls | 只问文件拿不拿得到 |
 *
 * 2026-09-23 连着栽了两次，两次都是"四样全绿、只有用户手机上看得见"：
 *
 *   1. `.chat` 写死 340px（`flex: none`），390px 的手机上画布只剩 **10×13** ——
 *      用户的原话是"没有照片"。
 *   2. 打开「微调」后，照片 / 对话 / 面板三样抢竖向空间，照片被压到 **64×86**——
 *      "图片小到看不见"。
 *
 * 所以这条检查量的是**画布在屏幕上占多大**（getBoundingClientRect），
 * 不是它的内部像素 —— 画布内部 3076×4096、屏幕上是 10×13，那两回事，
 * 而用户看见的只有后者。
 *
 * 判据用"长边 / 短边"而不是面积：手机拍的是竖图、仓库里的样片是横图，
 * 两种比例都得过。按面积判会在换一张比例不同的样片时莫名其妙地红。
 *
 * ⚠️ 两个容易写错的地方，这条脚本自己踩过：
 *   1. **必须掐掉 `/api/suggest`。** 那一路是真调模型的（花钱），而这条检查
 *      每次都要跑。卡片是可选件，掐掉不影响版面。
 *   2. **不能只看"元素存不存在"**。对话被隐藏时，输入框仍然拿得到（尺寸 0），
 *      拿存在性当判据等于白判。所以先看宽度 > 0 再判它在不在屏内。
 *
 * 用法（需要 dev 服务器开着）：
 *   npm run dev
 *   npm run check:layout
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const URL = process.env.DEV_BASE ?? 'http://localhost:5173'
/** 仓库里已有的样片，不必另存一张大图。比例是横的（1200×800），
 *  而真机是竖的 —— 两种都要能过，所以判据用的是长边/短边。 */
const PHOTO = join(ROOT, 'test-photos', 'e2e_first_use.jpg')

/**
 * 量哪几屏。
 *
 * 手机那一档是原来就有的（iPhone 14；窄屏断点是 640，所以它落在"上下排"那一侧）：
 * 那一档里画布是被**宽度**卡住的（390 − 40 内边距 = 350），也就是说**高度那条链
 * 从来没被激活过** —— 把 .canvas-wrap 的 height: 100% 摘掉，它照样全绿。
 *
 * 2026-09-23 补桌面这一档 1280×600：走**左右排**，而且**横竖都短** ——
 * 高度那条链（.stage 的 flex 高度 → .canvas-wrap 的 height: 100% →
 * .canvas 的 max-height: 100%）只有在"高度真的不够"的屏上才会吃上劲。
 */
const VIEWS = [
  { name: '手机 390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: '桌面 1280x600', width: 1280, height: 600, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
]
const MIN_LONG = 240   // 照片的长边至少这么长，否则就是"一个点"
const MIN_SHORT = 150  // 短边也不能是一条
/** 1px 容差：子像素舍入会稳定地差一个像素，而"差 1px"不是用户看得见的问题。 */
const TOL = 1

/** 量一屏。返回画布在**屏幕上**的尺寸，和几个辅助判据。 */
async function measure(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const c = document.querySelector('canvas')
    const bar = document.querySelector('.topbar')
    return {
      canvas: box(c),
      canvasPixels: c ? `${c.width}x${c.height}` : null,
      input: box(document.querySelector('form.chat-input')),
      buttons: [...document.querySelectorAll('.actions button')].map(b => b.textContent),
      topbarOverflow: bar ? bar.scrollWidth > bar.clientWidth : false,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

const fails = []
function judge(label, m, view) {
  const c = m.canvas
  const long = Math.max(c.w, c.h)
  const short = Math.min(c.w, c.h)
  console.log(`── ${label}`)
  console.log(`     画布（屏幕上） ${c.w}x${c.h} @${c.left},${c.top}   （内部像素 ${m.canvasPixels}）`)
  console.log(`     顶栏按钮 ${m.buttons.join(' / ')}`)
  if (long < MIN_LONG || short < MIN_SHORT) {
    fails.push(`${label}：照片在屏幕上只有 ${c.w}x${c.h} —— 用户看不见（至少要 ${MIN_LONG}x${MIN_SHORT}）`)
  }
  // 顶栏挤爆过一次（一个按钮就能挤），所以按**最坏情况**量：见下面注入的那段。
  if (m.topbarOverflow) {
    fails.push(`${label}：顶栏放不下这些按钮（${m.buttons.join(' / ')}）`)
  }
  // 输入框被隐藏时尺寸是 0，这时候不该判它 —— 否则是拿"存在"当"可见"
  if (m.input && m.input.w > 0 && m.input.bottom > view.height + 1) {
    fails.push(`${label}：输入框底边 ${m.input.bottom} 超出屏幕 ${view.height}`)
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
  // ★ 2026-09-23 加。上面那四条**一条都看不见"被切掉"**：`.app` 是 overflow: hidden，
  //   画布比 stage 高的话是被**切掉**的 —— 不出滚动条、不横向溢出、输入框也还在屏内。
  //   用户看到的是"照片下半截没了"，而检查全绿。所以必须直接问"它整个在视口里吗"。
  //   ⚠️ 判据**不写死任何尺寸**，只比"在不在视口内"：换一张比例不同的样片时，
  //   按尺寸判会莫名其妙地红（文件开头那条理由）。
  if (c.top < -TOL || c.left < -TOL || c.bottom > view.height + TOL || c.right > view.width + TOL) {
    fails.push(
      `${label}：画布没有完整落在视口里（${c.w}x${c.h} @${c.left},${c.top}，` +
      `视口 ${view.width}x${view.height}）—— 超出屏幕的那部分被切掉了，用户看不全照片`)
  }
}

const browser = await chromium.launch()
try {
  for (const view of VIEWS) {
    const page = await browser.newPage({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: view.deviceScaleFactor, isMobile: view.isMobile, hasTouch: view.hasTouch,
    })
    try {
      // 这一路会真调模型（花钱），而且它跟版面无关。必须掐掉。
      await page.route('**/api/suggest', r => r.abort())

      // **假装这台设备支持分享。** 真实的无头 Chromium 不支持，于是顶栏只有
      // 两个按钮 —— 那是宽松的那一侧，量它等于没量。分享按钮出来之后是三个，
      // 那才是会挤爆的那一侧。**每一档都要带上它**，否则量的是宽松的那一侧。
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'canShare', {
          value: d => !!(d && d.files && d.files.length), configurable: true,
        })
        Object.defineProperty(navigator, 'share', {
          value: async () => {}, configurable: true,
        })
      })

      try {
        await page.goto(URL, { waitUntil: 'load' })
      } catch {
        console.log(`❌ 连不上 ${URL} —— dev 服务器开着吗？（npm run dev）`)
        process.exitCode = 1
        process.exit()
      }

      await page.setInputFiles('input[type="file"]', PHOTO)
      await page.waitForSelector('canvas', { timeout: 15_000 })
      await page.waitForTimeout(1200)
      judge(`${view.name} · 刚传完照片`, await measure(page), view)

      await page.getByRole('button', { name: '微调' }).click()
      await page.waitForTimeout(500)
      judge(`${view.name} · 打开微调面板后`, await measure(page), view)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  for (const f of fails) console.log('❌', f)
  console.log('')
  console.log('窄屏规则在 src/styles.css 末尾那条 @media (max-width: 640px)；')
  console.log('宽窄两档共用的画布容器规则是 .canvas-wrap / .canvas（文件中部）。')
  process.exitCode = 1
} else {
  console.log(`✅ ${VIEWS.length} 档 × 2 种状态都过：照片 ≥ ${MIN_LONG}x${MIN_SHORT}、` +
    `画布完整在视口内、输入框在屏内、不用左右滑`)
}
