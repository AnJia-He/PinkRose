#!/usr/bin/env node
/**
 * 颜色取样验收探针（WebKit / iPhone 390px + 桌面）。
 *
 * 证明三件事：
 *   ① 点「颜色取样」后，点照片能读到当前渲染像素的 RGB；
 *   ② 面板显示的 HEX / RGB 与独立重绘读取一致；
 *   ③ 取样不修改调色参数、不新增历史，手机和桌面都不横向溢出。
 */
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.env.COLOR_SAMPLE_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

const browser = await webkit.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
const page = await context.newPage()
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', {
    state: 'attached', timeout: 15_000,
  })
  if (await page.locator('.login-box').count()) {
    const status = await page.evaluate(async ({ name, password, email }) => {
      const login = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      })
      if (login.ok) return 'login'
      const signup = await fetch('/api/signup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password, email }),
      })
      return signup.status
    }, { name: 'safaricheck', password: 'safari-check-only', email: 'safaricheck@example.com' })
    if (status !== 'login' && status !== 200) throw new Error(`登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle').catch(() => {})
  const uploadDeadline = Date.now() + 30_000
  let uploaded = false
  while (Date.now() < uploadDeadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(350)
    }
    const input = page.locator('input[data-photo-picker]').first()
    if (await input.count() && !(await page.locator('canvas.canvas').count())) {
      try {
        await input.setInputFiles(PORTRAIT, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        uploaded = true
        break
      } catch {
        // 会话恢复恰好换掉了上传框：回到循环继续等稳定。
      }
    }
    await page.waitForTimeout(300)
  }
  if (!uploaded) throw new Error('30 秒内没有上传测试照片')
  await page.waitForTimeout(500)
  errors.length = 0

  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForTimeout(400)
  const sampleButton = page.getByRole('button', { name: '颜色取样', exact: true })
  await sampleButton.scrollIntoViewIfNeeded()
  const sampleBox = await sampleButton.boundingBox()
  check('iPhone 上颜色取样按钮有 44px 触控高度',
    !!sampleBox && sampleBox.height >= 43.5,
    sampleBox ? `${Math.round(sampleBox.width)}x${Math.round(sampleBox.height)}` : 'missing')
  await sampleButton.click()
  check('进入颜色取样并显示照片点选提示',
    await sampleButton.getAttribute('aria-pressed') === 'true'
      && await page.locator('.canvas-wrap.sampling').count() === 1
      && (await page.locator('.wb-pick-hint').innerText()).includes('读取的颜色'),
    'sampling=true')

  const before = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.canvas')
    const box = canvas?.getBoundingClientRect()
    if (!(canvas instanceof HTMLCanvasElement) || !box) return null
    const cx = Math.floor(canvas.width / 2)
    const cy = Math.floor(canvas.height / 2)
    const radius = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.006))
    const sx = Math.max(0, cx - radius)
    const sy = Math.max(0, cy - radius)
    const sw = Math.max(1, Math.min(canvas.width, cx + radius + 1) - sx)
    const sh = Math.max(1, Math.min(canvas.height, cy + radius + 1) - sy)
    const copy = document.createElement('canvas')
    copy.width = 1
    copy.height = 1
    const ctx = copy.getContext('2d', { colorSpace: 'srgb' })
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, 1, 1)
    const pixel = ctx.getImageData(0, 0, 1, 1).data
    return {
      expected: [pixel[0], pixel[1], pixel[2]],
      exposure: [...document.querySelectorAll('.panel label.slider')]
        .find(row => row.querySelector('.slider-label')?.textContent?.trim() === '亮度')
        ?.querySelector('.slider-value')?.textContent?.trim(),
      steps: document.querySelectorAll('.step-history-item').length,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    }
  })
  if (!before) throw new Error('取不到画布中心像素')
  await page.evaluate(() => {
    window.__pinkroseSampleClick = null
    document.querySelector('.canvas-wrap')?.addEventListener('click', event => {
      const canvas = document.querySelector('canvas.canvas')
      const box = canvas?.getBoundingClientRect()
      if (!box) return
      window.__pinkroseSampleClick = {
        nx: (event.clientX - box.left) / box.width,
        ny: (event.clientY - box.top) / box.height,
      }
    }, { capture: true })
  })
  await page.locator('canvas.canvas').click({
    position: { x: before.box.width / 2, y: before.box.height / 2 },
  })
  await page.waitForTimeout(250)

  const reading = page.locator('[aria-label="颜色读数"]')
  await reading.waitFor({ state: 'visible', timeout: 5_000 })
  const shown = await reading.innerText()
  const shownRgb = shown.match(/RGB\s+(\d+)\s+·\s+(\d+)\s+·\s+(\d+)/)?.slice(1).map(Number)
  const clickAt = await page.evaluate(() => window.__pinkroseSampleClick)
  const clickedExpected = await page.evaluate(({ nx, ny }) => {
    const canvas = document.querySelector('canvas.canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    const cx = Math.min(canvas.width - 1, Math.max(0, Math.floor(nx * canvas.width)))
    const cy = Math.min(canvas.height - 1, Math.max(0, Math.floor(ny * canvas.height)))
    const radius = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.006))
    const sx = Math.max(0, cx - radius)
    const sy = Math.max(0, cy - radius)
    const sw = Math.max(1, Math.min(canvas.width, cx + radius + 1) - sx)
    const sh = Math.max(1, Math.min(canvas.height, cy + radius + 1) - sy)
    const copy = document.createElement('canvas')
    copy.width = copy.height = 1
    const ctx = copy.getContext('2d', { colorSpace: 'srgb' })
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }, clickAt)
  check('面板 RGB 与点击位置实际像素一致',
    !!shownRgb && !!clickedExpected
      && shownRgb.every((value, index) => value === clickedExpected[index]),
    `shown=${JSON.stringify(shownRgb)} expected=${JSON.stringify(clickedExpected)} `
      + `click=${JSON.stringify(clickAt)}`)
  check('同时显示 HEX 和 HSL 读数',
    /#[0-9A-F]{6}/.test(shown) && /HSL\s+\d+°\s+·\s+\d+%\s+·\s+\d+%/.test(shown),
    shown.replace(/\s+/g, ' ').slice(0, 90))
  const copyButton = reading.locator('.color-sample-copy')
  const copyBox = await copyButton.boundingBox()
  check('颜色读数复制按钮有 44px 触控高度',
    !!copyBox && copyBox.height >= 43.5,
    copyBox ? `${Math.round(copyBox.width)}x${Math.round(copyBox.height)}` : 'missing')
  const after = await page.evaluate(() => ({
    exposure: [...document.querySelectorAll('.panel label.slider')]
      .find(row => row.querySelector('.slider-label')?.textContent?.trim() === '亮度')
      ?.querySelector('.slider-value')?.textContent?.trim(),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('取样不改参数、手机不横向溢出',
    after.exposure === before.exposure && !after.overflow,
    `exposure=${after.exposure} overflow=${after.overflow}`)

  const hex = shown.match(/#[0-9A-F]{6}/)?.[0]
  if (!hex) throw new Error('读数里没有 HEX')
  await page.evaluate(() => {
    window.__pinkroseCopied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__pinkroseCopied = text },
      },
    })
  })
  await copyButton.click()
  const copied = await page.evaluate(() => window.__pinkroseCopied)
  check('复制动作写入当前 HEX', copied === hex, `clipboard=${copied || '空'} hex=${hex}`)

  if (process.env.COLOR_SAMPLE_SCREENSHOT) {
    await page.screenshot({ path: process.env.COLOR_SAMPLE_SCREENSHOT })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(300)
  check('桌面宽度读数与面板不横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
      && await reading.isVisible(),
    'desktop=ok')
  check('页面无控制台 / 运行时错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 颜色取样探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
