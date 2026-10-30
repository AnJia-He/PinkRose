#!/usr/bin/env node
/**
 * 明暗范围蒙版验收（WebKit / 390px）。
 *
 * 合成上亮下暗的测试图，选「高光」后压暗：
 *   ① 只有亮部改变，暗部保持原样；
 *   ② 明暗预设、范围、羽化和应用按钮真实可用；
 *   ③ iPhone 390px 不横向溢出，控制台无错误。
 */
import { webkit } from 'playwright'

const APP = process.env.LUMINANCE_MASK_APP ?? 'http://localhost:5173'
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function prepare(page) {
  await page.goto(`${APP}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
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
        body: JSON.stringify({ username: name, email, password }),
      })
      return signup.status
    }, { name: 'connectcheck', password: 'connect-check-only', email: 'connectcheck@example.com' })
    if (status !== 200 && status !== 'login') throw new Error(`测试账号登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (!(await page.locator('canvas.canvas').count())
      && await page.locator('input[type="file"]').count()) return
    if (await fresh.count() && await fresh.isVisible()) await fresh.click().catch(() => {})
    await page.waitForTimeout(250)
  }
  throw new Error('20 秒内没有回到上传页')
}

async function testPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    g.fillStyle = '#f2f2f2'
    g.fillRect(0, 0, c.width, c.height / 2)
    g.fillStyle = '#1d1d1d'
    g.fillRect(0, c.height / 2, c.width, c.height / 2)
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'luminance-mask.png',
    mimeType: 'image/png',
    buffer,
  })
  await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
  await page.waitForTimeout(700)
}

async function setLocalSlider(page, label, value) {
  const input = page.locator('.tool-row-second label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: label }) })
    .locator('input[type="range"]')
  await input.evaluate((node, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, String(next))
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await page.waitForTimeout(160)
}

async function meanColor(page, png, region) {
  return page.evaluate(async ({ b64, region }) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const x0 = Math.round(region.x0 * c.width)
    const x1 = Math.round(region.x1 * c.width)
    const y0 = Math.round(region.y0 * c.height)
    const y1 = Math.round(region.y1 * c.height)
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data
    let r = 0
    let gg = 0
    let b = 0
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      gg += d[i + 1]
      b += d[i + 2]
      n++
    }
    return { r: r / n, g: gg / n, b: b / n }
  }, { b64: png.toString('base64'), region })
}

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  await upload(page, await testPng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.locator('.tool-row-main [aria-label="局部"]').click()
  const row = page.locator('.tool-row-second')
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()

  await row.getByRole('button', { name: '明暗', exact: true }).click()
  const rangeGroup = row.getByRole('group', { name: '明暗范围' })
  check('局部蒙版提供「明暗」范围', await rangeGroup.count() === 1,
    `count=${await rangeGroup.count()}`)
  check('明暗范围有阴影 / 中间调 / 高光',
    await rangeGroup.getByRole('button').count() === 3,
    `buttons=${await rangeGroup.getByRole('button').count()}`)
  check('明暗范围有范围与羽化滑杆',
    await row.locator('.slider-label', { hasText: '范围' }).count() === 1
      && await row.locator('.slider-label', { hasText: '羽化' }).count() === 1,
    'range=1 feather=1')

  await rangeGroup.getByRole('button', { name: '高光', exact: true }).click()
  await setLocalSlider(page, '范围', 45)
  await setLocalSlider(page, '羽化', 35)
  await setLocalSlider(page, '亮度', -70)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  check('390px 明暗范围控件可用且不溢出',
    await rangeGroup.isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(250)

  await row.getByRole('button', { name: '应用局部', exact: true }).click()
  await row.waitFor({ state: 'detached', timeout: 30_000 })
  await page.waitForTimeout(500)
  const after = await canvas.screenshot()
  const lightBefore = await meanColor(page, before, { x0: 0.15, x1: 0.85, y0: 0.10, y1: 0.38 })
  const lightAfter = await meanColor(page, after, { x0: 0.15, x1: 0.85, y0: 0.10, y1: 0.38 })
  const darkBefore = await meanColor(page, before, { x0: 0.15, x1: 0.85, y0: 0.62, y1: 0.90 })
  const darkAfter = await meanColor(page, after, { x0: 0.15, x1: 0.85, y0: 0.62, y1: 0.90 })
  const change = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
  const lightDelta = change(lightBefore, lightAfter)
  const darkDelta = change(darkBefore, darkAfter)
  check('选高光后只压暗亮部，暗部保持原样',
    lightDelta > 30 && darkDelta < 3,
    `lightΔ=${lightDelta.toFixed(1)} darkΔ=${darkDelta.toFixed(1)}`)
  check('明暗范围流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 明暗范围探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
