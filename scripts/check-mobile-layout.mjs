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

/** iPhone 14 那一档。窄屏断点是 640，所以这里落在"上下排"那一侧。 */
const VIEW = { width: 390, height: 844 }
const MIN_LONG = 240   // 照片的长边至少这么长，否则就是"一个点"
const MIN_SHORT = 150  // 短边也不能是一条

/** 量一屏。返回画布在**屏幕上**的尺寸，和几个辅助判据。 */
async function measure(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }
    }
    const c = document.querySelector('canvas')
    return {
      canvas: box(c),
      canvasPixels: c ? `${c.width}x${c.height}` : null,
      input: box(document.querySelector('form.chat-input')),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

const fails = []
function judge(label, m) {
  const c = m.canvas
  const long = Math.max(c.w, c.h)
  const short = Math.min(c.w, c.h)
  console.log(`── ${label}`)
  console.log(`     画布（屏幕上） ${c.w}x${c.h}   （内部像素 ${m.canvasPixels}）`)
  if (long < MIN_LONG || short < MIN_SHORT) {
    fails.push(`${label}：照片在屏幕上只有 ${c.w}x${c.h} —— 用户看不见（至少要 ${MIN_LONG}x${MIN_SHORT}）`)
  }
  // 输入框被隐藏时尺寸是 0，这时候不该判它 —— 否则是拿"存在"当"可见"
  if (m.input && m.input.w > 0 && m.input.bottom > VIEW.height + 1) {
    fails.push(`${label}：输入框底边 ${m.input.bottom} 超出屏幕 ${VIEW.height}`)
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: VIEW, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  // 这一路会真调模型（花钱），而且它跟版面无关。必须掐掉。
  await page.route('**/api/suggest', r => r.abort())

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
  judge('刚传完照片', await measure(page))

  await page.getByRole('button', { name: '微调' }).click()
  await page.waitForTimeout(500)
  judge('打开微调面板后', await measure(page))
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  for (const f of fails) console.log('❌', f)
  console.log('')
  console.log('去 src/styles.css 末尾那条 @media (max-width: 640px) 看 ——')
  console.log('窄屏的版面规则都在那里。')
  process.exitCode = 1
} else {
  console.log(`✅ 两种状态都过：照片 ≥ ${MIN_LONG}x${MIN_SHORT}、输入框在屏内、不用左右滑`)
}
