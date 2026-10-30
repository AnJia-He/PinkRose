#!/usr/bin/env node
/**
 * 色彩分级与色调验收（WebKit / 390px）。
 *
 * 用一张从上到下由黑到白的灰阶图，分别给暗部 / 中间调 / 亮部着色：
 *   ① 三段各自在对应亮度产生颜色变化；
 *   ② 明暗平衡会重新分配三段权重；
 *   ③ 绿—洋红色调方向正确且不顺手改亮度；
 *   ④ 三组强度 / 色调都归零后画面恢复原样；
 *   ⑤ 390px 控件可达且不横向溢出。
 */
import { webkit } from 'playwright'

const APP = process.env.COLOR_GRADING_APP ?? 'http://localhost:5173'
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

async function gradientPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 800
    c.height = 600
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    for (let y = 0; y < c.height; y++) {
      const value = Math.round(255 * y / (c.height - 1))
      g.fillStyle = `rgb(${value}, ${value}, ${value})`
      g.fillRect(0, y, c.width, 1)
    }
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'color-grading.png',
    mimeType: 'image/png',
    buffer,
  })
  await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
  await page.waitForTimeout(700)
}

async function setPanelSlider(page, label, value) {
  const input = page.getByRole('slider', { name: label, exact: true })
  await input.evaluate((node, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, String(next))
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await page.waitForTimeout(180)
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

async function meanAbsDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const size = 240
    const normalize = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d')
      g.drawImage(bmp, 0, 0, size, size)
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

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  await upload(page, await gradientPng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForTimeout(400)

  const labels = ['亮部颜色', '暗部颜色', '强度', '中间调颜色', '中间调强度', '明暗平衡']
  const visible = await Promise.all(labels.map(label =>
    page.getByRole('slider', { name: label, exact: true }).count()))
  check('分离色调提供三段六根控件', visible.every(n => n === 1),
    visible.map((n, i) => `${labels[i]}=${n}`).join(' '))

  const wbPresets = page.locator('[aria-label="白平衡预设"] button')
  check('白平衡提供五个常见预设', await wbPresets.count() === 5,
    `count=${await wbPresets.count()}`)
  await wbPresets.filter({ hasText: '阴天' }).evaluate(node => node.click())
  await page.waitForTimeout(180)
  const wbValues = await page.evaluate(() => {
    const value = label => [...document.querySelectorAll('.panel label.slider')]
      .find(row => row.querySelector('.slider-label')?.textContent?.trim() === label)
      ?.querySelector('.slider-value')?.textContent?.trim()
    return { temperature: value('色温'), tint: value('色调') }
  })
  check('阴天预设只写色温 / 色调', wbValues.temperature === '12' && wbValues.tint === '4',
    `色温=${wbValues.temperature} 色调=${wbValues.tint}`)
  await wbPresets.filter({ hasText: '日光' }).evaluate(node => node.click())
  await page.waitForTimeout(180)
  const daylight = await page.evaluate(() => {
    const value = label => [...document.querySelectorAll('.panel label.slider')]
      .find(row => row.querySelector('.slider-label')?.textContent?.trim() === label)
      ?.querySelector('.slider-value')?.textContent?.trim()
    return { temperature: value('色温'), tint: value('色调') }
  })
  check('日光预设回到 0 / 0', daylight.temperature === '0' && daylight.tint === '0',
    `色温=${daylight.temperature} 色调=${daylight.tint}`)

  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()
  const tintBefore = await meanColor(page, before, { x0: 0.2, x1: 0.8, y0: 0.44, y1: 0.56 })
  await setPanelSlider(page, '色调', 100)
  await page.waitForTimeout(300)
  const magenta = await canvas.screenshot()
  const tintMagenta = await meanColor(page, magenta, { x0: 0.2, x1: 0.8, y0: 0.44, y1: 0.56 })
  const luma = color => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
  check('色调 +100 往洋红偏、绿色下降', tintMagenta.g < tintBefore.g - 2,
    `Δg=${(tintMagenta.g - tintBefore.g).toFixed(1)}`)
  check('色调 +100 基本不改整体亮度', Math.abs(luma(tintMagenta) - luma(tintBefore)) < 3,
    `Δluma=${Math.abs(luma(tintMagenta) - luma(tintBefore)).toFixed(2)}`)

  await setPanelSlider(page, '色调', -100)
  await page.waitForTimeout(300)
  const green = await canvas.screenshot()
  const tintGreen = await meanColor(page, green, { x0: 0.2, x1: 0.8, y0: 0.44, y1: 0.56 })
  check('色调 -100 往绿色偏、绿色上升', tintGreen.g > tintBefore.g + 2,
    `Δg=${(tintGreen.g - tintBefore.g).toFixed(1)}`)
  await setPanelSlider(page, '色调', 0)
  await page.waitForTimeout(300)
  const tintReset = await canvas.screenshot()
  const tintResetDiff = await meanAbsDiff(page, before, tintReset)
  check('色调归零后画面完全复原', tintResetDiff < 0.05,
    `meanAbsDiff=${tintResetDiff.toFixed(3)}`)

  await setPanelSlider(page, '暗部颜色', 210)
  await setPanelSlider(page, '强度', 45)
  await setPanelSlider(page, '中间调颜色', 120)
  await setPanelSlider(page, '中间调强度', 60)
  await page.waitForTimeout(400)
  const graded = await canvas.screenshot()

  const darkBefore = await meanColor(page, before, { x0: 0.2, x1: 0.8, y0: 0.10, y1: 0.24 })
  const darkAfter = await meanColor(page, graded, { x0: 0.2, x1: 0.8, y0: 0.10, y1: 0.24 })
  const midBefore = await meanColor(page, before, { x0: 0.2, x1: 0.8, y0: 0.44, y1: 0.56 })
  const midAfter = await meanColor(page, graded, { x0: 0.2, x1: 0.8, y0: 0.44, y1: 0.56 })
  const highBefore = await meanColor(page, before, { x0: 0.2, x1: 0.8, y0: 0.82, y1: 0.94 })
  const highAfter = await meanColor(page, graded, { x0: 0.2, x1: 0.8, y0: 0.82, y1: 0.94 })
  check('暗部只往蓝色偏', (darkAfter.b - darkAfter.r) - (darkBefore.b - darkBefore.r) > 3,
    `Δ(b-r)=${((darkAfter.b - darkAfter.r) - (darkBefore.b - darkBefore.r)).toFixed(1)}`)
  check('中间调只往绿色偏', (midAfter.g - midAfter.r) - (midBefore.g - midBefore.r) > 3,
    `Δ(g-r)=${((midAfter.g - midAfter.r) - (midBefore.g - midBefore.r)).toFixed(1)}`)
  check('亮部保持偏红', (highAfter.r - highAfter.b) - (highBefore.r - highBefore.b) > 0.5,
    `Δ(r-b)=${((highAfter.r - highAfter.b) - (highBefore.r - highBefore.b)).toFixed(1)}`)

  await setPanelSlider(page, '明暗平衡', -80)
  await page.waitForTimeout(350)
  const balanced = await canvas.screenshot()
  const balanceDiff = await meanAbsDiff(page, graded, balanced)
  check('明暗平衡重新分配三段权重', balanceDiff > 0.05, `meanAbsDiff=${balanceDiff.toFixed(3)}`)

  await setPanelSlider(page, '强度', 0)
  await setPanelSlider(page, '中间调强度', 0)
  await setPanelSlider(page, '明暗平衡', 0)
  await page.waitForTimeout(350)
  const reset = await canvas.screenshot()
  const resetDiff = await meanAbsDiff(page, before, reset)
  check('两组强度归零后画面完全复原', resetDiff < 0.05, `meanAbsDiff=${resetDiff.toFixed(3)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  const group = page.locator('.panel-groups .panel-group')
    .filter({ has: page.locator('.panel-group-title', { hasText: '分离色调' }) })
  check('390px 三段分级控件可达且不横向溢出',
    await group.count() === 1 && await group.isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  check('色彩分级与色调控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 色彩分级与色调探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
