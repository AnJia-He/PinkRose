#!/usr/bin/env node
/**
 * 移轴模糊验收（WebKit / 390px）。
 *
 * 上传一张满幅细纹理测试图，在「镜头」里切到移轴并推到 100：
 *   ① 清晰带中心保持锐利，带外纹理明显下降；
 *   ② 角度滑杆真的旋转清晰带；
 *   ③ 390px 控制区不横向溢出，控制台无错误。
 */
import { webkit } from 'playwright'

const BASE = process.env.TILT_SHIFT_BASE ?? 'http://localhost:5173'
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function prepare(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
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
    }, { name: 'tiltcheck', password: 'tilt-check-only', email: 'tiltcheck@example.com' })
    if (status !== 200 && status !== 'login') {
      throw new Error(`测试账号登录/注册失败：HTTP ${status}`)
    }
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
}

async function texturePng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    const bg = g.createLinearGradient(0, 0, c.width, c.height)
    bg.addColorStop(0, '#17212b')
    bg.addColorStop(0.5, '#35505f')
    bg.addColorStop(1, '#11151a')
    g.fillStyle = bg
    g.fillRect(0, 0, c.width, c.height)
    let seed = 20261021
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < 36000; i++) {
      const v = Math.round(45 + rand() * 190)
      g.fillStyle = `rgb(${v},${Math.min(255, v + 8)},${Math.min(255, v + 16)})`
      const size = rand() < 0.8 ? 2 : 5
      g.fillRect(rand() * c.width, rand() * c.height, size, size)
    }
    g.strokeStyle = 'rgba(255,255,255,.32)'
    g.lineWidth = 3
    for (let x = 60; x < c.width; x += 120) {
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x, c.height)
      g.stroke()
    }
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(350)
    }
    const input = page.locator('input[type="file"]').first()
    if (await input.count()) {
      try {
        await input.setInputFiles({
          name: 'tilt-shift-e2e.png',
          mimeType: 'image/png',
          buffer,
        }, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(700)
        return
      } catch {
        // 会话恢复可能刚好换掉上传框；回到循环重新开一张。
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error('30 秒内没把移轴测试图传上去')
}

function slider(page, label) {
  return page.locator('.panel label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: label }) })
    .locator('input[type="range"]')
}

async function setSlider(page, label, value) {
  const input = slider(page, label)
  await input.evaluate((node, next) => {
    const el = node
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, String(next))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await page.waitForTimeout(180)
}

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
    for (const [name, region] of Object.entries(regions)) {
      const x0 = Math.max(2, Math.round(region.x0 * width))
      const x1 = Math.min(width - 2, Math.round(region.x1 * width))
      const y0 = Math.max(2, Math.round(region.y0 * height))
      const y1 = Math.min(height - 2, Math.round(region.y1 * height))
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
    return out
  }, { b64: png.toString('base64'), regions })
}

let browser
try {
  browser = await webkit.launch()
} catch (e) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  await upload(page, await texturePng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await setSlider(page, '虚化强度', 0)
  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()

  await page.getByRole('button', { name: '移轴', exact: true }).click()
  await setSlider(page, '清晰范围', -50)
  await setSlider(page, '过渡', -50)
  await setSlider(page, '移轴角度', 40)
  await setSlider(page, '虚化强度', 100)
  await page.waitForSelector('.lens-focus-band', { timeout: 5_000 })
  await page.waitForTimeout(500)

  const shape = await page.evaluate(() => {
    const band = document.querySelector('.lens-focus-band')
    return band ? { transform: band.style.transform, height: band.style.height } : null
  })
  check('清晰带出现在照片上并被角度滑杆旋转',
    !!shape && /rotate\(36(?:\.0+)?deg\)/.test(shape.transform),
    shape ? `${shape.transform} height=${shape.height}` : '没有清晰带')

  // 截图是合成后的画面；先摘掉辅助线，避免白线本身参与清晰度读数。
  await page.evaluate(() => {
    const overlay = document.querySelector('.lens-focus')
    if (overlay instanceof HTMLElement) overlay.style.display = 'none'
  })
  await page.waitForTimeout(100)
  const after = await canvas.screenshot()

  const regions = {
    outside: { x0: 0.12, x1: 0.88, y0: 0.03, y1: 0.16 },
    // 角度 36° 时，清晰带在左右边缘会明显上下移动；只量中心附近，
    // 才能判断“这条带本身是不是清楚的”，而不是把带外区域算进来。
    band: { x0: 0.42, x1: 0.58, y0: 0.44, y1: 0.56 },
    topLeft: { x0: 0.08, x1: 0.28, y0: 0.03, y1: 0.16 },
    topRight: { x0: 0.72, x1: 0.92, y0: 0.03, y1: 0.16 },
  }
  const beforeSharp = await sharpnessOf(page, before, regions)
  const afterSharp = await sharpnessOf(page, after, regions)
  const outsideDrop = 1 - afterSharp.outside / Math.max(1e-6, beforeSharp.outside)
  const bandDrop = 1 - afterSharp.band / Math.max(1e-6, beforeSharp.band)
  check('带外纹理明显变糊', outsideDrop > 0.25,
    `${beforeSharp.outside.toFixed(1)} → ${afterSharp.outside.toFixed(1)}（-${(outsideDrop * 100).toFixed(1)}%）`)
  check('清晰带中心基本保持锐利', bandDrop < 0.1,
    `${beforeSharp.band.toFixed(1)} → ${afterSharp.band.toFixed(1)}（-${(bandDrop * 100).toFixed(1)}%）`)
  check('成片清晰带的倾斜方向与画布辅助线一致',
    afterSharp.topLeft > afterSharp.topRight * 1.15,
    `top-left=${afterSharp.topLeft.toFixed(1)} top-right=${afterSharp.topRight.toFixed(1)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth)
  check('390px 移轴控制区不横向溢出', !overflow, `overflow=${overflow}`)
  check('移轴流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.error('❌ 移轴探针中途失败：', e instanceof Error ? e.message : e)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
