#!/usr/bin/env node
/**
 * 磨皮验收探针（WebKit / 390px）。
 *
 * 单元测试只能证明"函数算得对、接线接上了"；这一条走真实浏览器：
 *   ① 上传一张正脸照片，进调色屏，找到「磨皮」滑杆；
 *   ② 把滑杆推到 100，截图比对**皮肤区域**的清晰度是否下降、整张是否真的变了；
 *   ③ 打开工具行的「磨皮」画笔，涂一小块、按「磨这里」，确认换底图且不报错。
 *
 * 先起开发服务器，再跑：
 *   npm run check:smooth
 */
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.SMOOTH_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function prepare(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    // 复用 check-safari 的固定账号，避免连续调试把注册限流打满。
    const status = await page.evaluate(async ({ name, password, email }) => {
      const login = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      })
      if (login.ok) return 'login'
      const r = await fetch('/api/signup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, email, password }),
      })
      return r.status
    }, { name: 'safaricheck', password: 'safari-check-only', email: 'safaricheck@example.com' })
    if (status !== 200 && status !== 'login') {
      throw new Error(`测试账号登录/注册失败：HTTP ${status}`)
    }
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 20_000 }).catch(() => {}),
  ])
}

async function uploadPortrait(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(400)
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) {
      try {
        await page.locator('input[type="file"]').first()
          .setInputFiles(PORTRAIT, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(800)
        return
      } catch {
        // 会话恢复刚好换掉了上传框；回到循环重开一张。
      }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('30 秒内没把正脸测试图传上去')
}

/** 截图里两块区域的清晰度（拉普拉斯响应的均方）。 */
async function sharpnessOf(page, png, regions) {
  return page.evaluate(async ({ b64, regions }) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height)
    const luma = (x, y) => {
      const i = (y * width + x) * 4
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    const out = {}
    for (const [name, r] of Object.entries(regions)) {
      const x0 = Math.max(2, Math.min(width - 3, Math.round(r.x0 * width)))
      const x1 = Math.max(3, Math.min(width - 2, Math.round(r.x1 * width)))
      const y0 = Math.max(2, Math.min(height - 3, Math.round(r.y0 * height)))
      const y1 = Math.max(3, Math.min(height - 2, Math.round(r.y1 * height)))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const lap = 4 * luma(x, y) - luma(x - 1, y) - luma(x + 1, y)
            - luma(x, y - 1) - luma(x, y + 1)
          sum += lap * lap
          n++
        }
      }
      out[name] = n ? sum / n : 0
    }
    return { width, height, sharpness: out }
  }, { b64: png.toString('base64'), regions })
}

async function meanAbsDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    // 工具第二行收起后照片区会变高，两张画布的屏幕尺寸不一定相同 ——
    // 都缩到同一块 240×240 的画布上再比，避免"尺寸不同 = 255"的假失败。
    const size = 240
    const normalize = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d')
      const k = Math.min(size / bmp.width, size / bmp.height)
      const w = bmp.width * k
      const h = bmp.height * k
      g.fillStyle = '#000'
      g.fillRect(0, 0, size, size)
      g.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h)
      return g.getImageData(0, 0, size, size).data
    }
    const da = await normalize(a)
    const db = await normalize(b)
    let sum = 0
    for (let i = 0; i < da.length; i += 4) {
      sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1])
        + Math.abs(da[i + 2] - db[i + 2])
    }
    return sum / (da.length / 4 * 3)
  }, { a: a.toString('base64'), b: b.toString('base64') })
}

let browser
try {
  browser = await webkit.launch()
} catch (e) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

// 先用桌面宽度量像素（390px 下照片只有 90 多像素宽，拉普拉斯读数太粗）；
// 画笔那一段再切回 iPhone 竖屏，布局和触控路径照样过一遍。
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

try {
  await prepare(page)
  errors.length = 0
  await uploadPortrait(page)
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForTimeout(500)

  // ① 参数滑杆：推满，截图比对。
  const skinSlider = page.locator('.panel label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: '磨皮' }) })
  check('调色面板有「磨皮」滑杆', await skinSlider.count() === 1,
    `count=${await skinSlider.count()}`)
  const canvas = page.locator('canvas.canvas')
  const range = skinSlider.locator('input[type="range"]')
  // 会话会自动恢复上一张（包括上一轮的参数）——先把磨皮归零，
  // 否则"推满"时已经是 100，截图会一模一样。
  await range.focus()
  await page.keyboard.press('Home')
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('.panel label.slider')]
      .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '磨皮')
    return label?.querySelector('.slider-value')?.textContent?.trim() === '0'
  }, null, { timeout: 5_000 })
  await page.waitForTimeout(500)
  const before = await canvas.screenshot()
  await range.focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('.panel label.slider')]
      .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '磨皮')
    return label?.querySelector('.slider-value')?.textContent?.trim() === '100'
  }, null, { timeout: 5_000 })
  await page.waitForTimeout(600)
  const after = await canvas.screenshot()
  const dumpDir = process.env.SMOOTH_DEBUG_DIR
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true })
    writeFileSync(join(dumpDir, 'slider-before.png'), before)
    writeFileSync(join(dumpDir, 'slider-after.png'), after)
  }

  const diff = await meanAbsDiff(page, before, after)
  const regions = {
    cheek: { x0: 0.24, x1: 0.46, y0: 0.42, y1: 0.62 },
    // 只框虹膜 / 睫毛这一小块：眼皮和眼周的皮肤本来就在磨皮范围里，
    // 把整块眼周都算进来会把"磨皮肤"误判成"把眼睛糊了"。
    eye: { x0: 0.84, x1: 0.97, y0: 0.205, y1: 0.275 },
  }
  const beforeSharp = await sharpnessOf(page, before, regions)
  const afterSharp = await sharpnessOf(page, after, regions)
  const cheekDrop = 1 - afterSharp.sharpness.cheek / Math.max(1e-6, beforeSharp.sharpness.cheek)
  const eyeDrop = 1 - afterSharp.sharpness.eye / Math.max(1e-6, beforeSharp.sharpness.eye)
  check('磨皮滑杆真的改变画面', diff > 0.2, `meanAbsDiff=${diff.toFixed(3)}`)
  check('皮肤区域纹理下降（磨到了）', cheekDrop > 0.03,
    `cheek sharpness ${beforeSharp.sharpness.cheek.toFixed(1)} → `
      + `${afterSharp.sharpness.cheek.toFixed(1)}（-${(cheekDrop * 100).toFixed(1)}%）`)
  check('眼睛边缘基本保住（没有整张糊掉）', eyeDrop < 0.12,
    `eye sharpness ${beforeSharp.sharpness.eye.toFixed(1)} → `
      + `${afterSharp.sharpness.eye.toFixed(1)}（-${(eyeDrop * 100).toFixed(1)}%）`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  check('磨皮后 390px 不横向溢出',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')

  // ② 画笔：涂一小块 → 磨这里 → 换底图、收工具。
  await page.locator('.tool-row-main [aria-label="磨皮"]').click()
  const row = page.locator('.tool-row-second')
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const done = row.getByRole('button', { name: '磨这里', exact: true })
  check('磨皮画笔第二行可用',
    await row.locator('.slider-label', { hasText: '强度' }).count() === 1
      && await row.locator('.slider-label', { hasText: '纹理' }).count() === 1
      && await done.isDisabled(),
    `strength=1 texture=1 doneDisabled=${await done.isDisabled()}`)

  const paintBefore = await canvas.screenshot()
  const overlay = page.locator('.retouch')
  const box = await overlay.boundingBox()
  const photoBox = await canvas.boundingBox()
  if (!box || !photoBox) throw new Error('磨皮涂抹层或照片没有出现')
  // ⚠️ 照片只占涂抹层中间的一条（竖图在 390px 宽下左右留白很大）——
  // 落笔要按**照片**的盒子算，按外层的盒子算会点在留白上（不算起笔）。
  const x0 = photoBox.x + photoBox.width * 0.3
  const y0 = photoBox.y + photoBox.height * 0.5
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return {
      tag: el?.tagName ?? '',
      className: typeof el?.className === 'string' ? el.className : '',
      inRetouch: !!el?.closest?.('.retouch'),
    }
  }, { x: x0, y: y0 })
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x0 + photoBox.width * 0.04 * i, y0 + photoBox.height * 0.005 * i)
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
  const canPaint = await done.isEnabled()
  const paintDebug = canPaint ? null : await page.evaluate(() => {
    const mask = document.querySelector('.retouch-mask')
    const photo = document.querySelector('canvas.canvas')
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    let inked = 0
    if (mask instanceof HTMLCanvasElement) {
      const g = mask.getContext('2d')
      const d = g?.getImageData(0, 0, mask.width, mask.height).data
      if (d) for (let i = 3; i < d.length; i += 4) if (d[i]) inked++
    }
    return {
      cursor: document.querySelectorAll('.retouch-cursor').length,
      inked,
      overlay: box(document.querySelector('.retouch')),
      mask: box(mask),
      photo: box(photo),
    }
  })
  check('涂过之后「磨这里」可按', canPaint,
    `disabled=${!canPaint} hit=${hit.tag}.${hit.className} inRetouch=${hit.inRetouch}`
      + (paintDebug ? ` debug=${JSON.stringify(paintDebug)}` : ''))
  if (canPaint) {
    await done.click()
    await row.waitFor({ state: 'detached', timeout: 30_000 })
    await page.waitForTimeout(400)
    const paintAfter = await canvas.screenshot()
    if (dumpDir) writeFileSync(join(dumpDir, 'brush-after.png'), paintAfter)
    const paintDiff = await meanAbsDiff(page, paintBefore, paintAfter)
    check('画笔磨皮真的换了底图', paintDiff > 0.05, `meanAbsDiff=${paintDiff.toFixed(3)}`)
  }
  check('画笔磨皮收工具、控制台无错', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.error('❌ 磨皮探针中途失败：', e instanceof Error ? e.message : e)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
