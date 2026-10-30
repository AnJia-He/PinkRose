#!/usr/bin/env node
/**
 * 相连区域选择验收（WebKit / 390px）。
 *
 * 合成两个完全同色但不相连的红块，点左边那块：
 *   ① 只有左侧红块进入蒙版，右侧同色块保持原样；
 *   ② 应用局部后画面结果符合这个判断；
 *   ③ 390px 控件可用、无横向溢出、控制台无错误。
 */
import { webkit } from 'playwright'

const APP = process.env.CONNECTED_SELECT_APP ?? 'http://localhost:5173'
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
    g.fillStyle = '#7d8791'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#c83c3c'
    g.fillRect(c.width * 0.08, c.height * 0.30, c.width * 0.20, c.height * 0.40)
    g.fillRect(c.width * 0.72, c.height * 0.30, c.width * 0.20, c.height * 0.40)
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'connected-select.png',
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
  await page.waitForSelector('.tool-row-main [aria-label="局部"]', { timeout: 10_000 })
  await page.locator('.tool-row-main [aria-label="局部"]').click()
  const row = page.locator('.tool-row-second')
  await row.getByRole('button', { name: '色彩范围', exact: true }).click()
  const connected = row.getByRole('button', { name: '相连区域', exact: true })
  check('色彩范围提供相连区域开关', await connected.count() === 1,
    `count=${await connected.count()}`)
  await connected.click()
  await row.getByRole('button', { name: '点选颜色', exact: true }).click()

  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('画布没有可点击区域')
  await page.mouse.click(box.x + box.width * 0.18, box.y + box.height * 0.5)
  await page.waitForTimeout(350)
  await setLocalSlider(page, '亮度', 80)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  check('390px 相连区域控件可用且不溢出',
    await connected.isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(250)

  await row.getByRole('button', { name: '应用局部', exact: true }).click()
  await row.waitFor({ state: 'detached', timeout: 30_000 })
  await page.waitForTimeout(400)
  const after = await canvas.screenshot()
  const leftBefore = await meanColor(page, before, { x0: 0.11, x1: 0.25, y0: 0.35, y1: 0.65 })
  const leftAfter = await meanColor(page, after, { x0: 0.11, x1: 0.25, y0: 0.35, y1: 0.65 })
  const rightBefore = await meanColor(page, before, { x0: 0.75, x1: 0.89, y0: 0.35, y1: 0.65 })
  const rightAfter = await meanColor(page, after, { x0: 0.75, x1: 0.89, y0: 0.35, y1: 0.65 })
  const leftChange = Math.abs(leftAfter.r - leftBefore.r)
    + Math.abs(leftAfter.g - leftBefore.g)
    + Math.abs(leftAfter.b - leftBefore.b)
  const rightChange = Math.abs(rightAfter.r - rightBefore.r)
    + Math.abs(rightAfter.g - rightBefore.g)
    + Math.abs(rightAfter.b - rightBefore.b)
  check('点左侧红块只修改相连区域，不波及右侧同色块',
    leftChange > 20 && rightChange < 3,
    `leftΔ=${leftChange.toFixed(1)} rightΔ=${rightChange.toFixed(1)}`)
  check('相连区域流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 相连区域探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
