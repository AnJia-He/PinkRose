#!/usr/bin/env node
/** 黑白混色验收（WebKit / 390px）。 */
import { webkit } from 'playwright'

const BASE = process.env.BW_BASE ?? 'http://localhost:5173'
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function prepare(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    await page.evaluate(async () => {
      const body = {
        username: 'safaricheck',
        password: 'safari-check-only',
        email: 'safaricheck@example.com',
      }
      const login = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: body.username, password: body.password }),
      })
      if (login.ok) return
      await fetch('/api/signup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    })
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  const fresh = page.getByRole('button', { name: '新的一张', exact: true })
  if (await fresh.count() && await fresh.isVisible()) await fresh.click()
  await page.waitForFunction(
    () => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'),
    null,
    { timeout: 15_000 },
  )
}

async function uploadBlocks(page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 300
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('test canvas unavailable')
    const colors = ['rgb(210, 45, 45)', 'rgb(45, 190, 45)', 'rgb(45, 45, 210)']
    colors.forEach((color, index) => {
      ctx.fillStyle = color
      ctx.fillRect(index * 200, 0, 200, 300)
    })
    return canvas.toDataURL('image/png')
  })
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(300)
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) {
      try {
        await page.locator('input[type="file"]').first().setInputFiles({
          name: 'bw-mix.png',
          mimeType: 'image/png',
          buffer,
        }, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        break
      } catch {
        await page.waitForTimeout(300)
        continue
      }
    }
    await page.waitForTimeout(300)
  }
  if (!(await page.locator('canvas.canvas').count())) {
    throw new Error('30 秒内没有把黑白测试图传上去')
  }
  await page.waitForTimeout(700)
}

async function setSlider(page, name, value) {
  const slider = page.getByRole('slider', { name, exact: true })
  await slider.evaluate((node, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, String(next))
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await page.waitForTimeout(180)
}

async function colors(page, png) {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const read = (x0, x1) => {
      const data = ctx.getImageData(
        Math.round(x0 * canvas.width),
        Math.round(0.35 * canvas.height),
        Math.round((x1 - x0) * canvas.width),
        Math.round(0.3 * canvas.height),
      ).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        n++
      }
      return { r: r / n, g: g / n, b: b / n }
    }
    return { red: read(0.05, 0.28), green: read(0.39, 0.61), blue: read(0.72, 0.95) }
  }, png.toString('base64'))
}

const luma = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
const isGray = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 2
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push(e.message))

try {
  await prepare(page)
  errors.length = 0
  await uploadBlocks(page)
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  const canvas = page.locator('canvas.canvas')
  const before = await colors(page, await canvas.screenshot())

  await setSlider(page, '黑白强度', 100)
  const neutral = await colors(page, await canvas.screenshot())
  check('黑白强度 100：红 / 绿 / 蓝三块都成为灰色',
    [neutral.red, neutral.green, neutral.blue].every(isGray),
    [neutral.red, neutral.green, neutral.blue]
      .map(c => `${c.r.toFixed(1)}/${c.g.toFixed(1)}/${c.b.toFixed(1)}`).join(' | '))

  await setSlider(page, '红色混色', 100)
  const redBoost = await colors(page, await canvas.screenshot())
  check('红色混色 +100：红色物体单独变亮',
    luma(redBoost.red) > luma(neutral.red) + 4,
    `Δluma=${(luma(redBoost.red) - luma(neutral.red)).toFixed(1)}`)

  await setSlider(page, '红色混色', 0)
  await setSlider(page, '黑白强度', 0)
  const reset = await colors(page, await canvas.screenshot())
  const resetDelta = Math.max(
    Math.abs(reset.red.r - before.red.r), Math.abs(reset.red.g - before.red.g),
    Math.abs(reset.green.r - before.green.r), Math.abs(reset.green.g - before.green.g),
    Math.abs(reset.blue.b - before.blue.b), Math.abs(reset.blue.g - before.blue.g),
  )
  check('黑白强度 / 混色归零后恢复彩色', resetDelta < 2,
    `maxChannelDelta=${resetDelta.toFixed(2)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  check('390px 黑白控件不横向溢出',
    await page.getByRole('slider', { name: '黑白强度', exact: true }).count() === 1
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'slider=1 overflow=false')
  check('黑白混色控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 黑白混色探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error(errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
