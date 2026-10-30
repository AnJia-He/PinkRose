#!/usr/bin/env node
/**
 * 锐化半径 / 蒙版验收（WebKit / 390px）。
 *
 *   ① 锐化后强边缘细节上升；
 *   ② 锐化蒙版提高后，低幅噪声区不再被明显放大；
 *   ③ 改半径会改变实际采样结果；
 *   ④ 强度归零时画面逐像素复原；
 *   ⑤ 390px 控件可达、无横向溢出。
 */
import { webkit } from 'playwright'

const APP = process.env.SHARPEN_APP ?? 'http://localhost:5173'
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

async function sharpPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 720
    c.height = 480
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    g.fillStyle = 'rgb(80, 80, 80)'
    g.fillRect(0, 0, c.width * 0.43, c.height)
    g.fillStyle = 'rgb(190, 190, 190)'
    g.filter = 'blur(5px)'
    g.fillRect(c.width * 0.43 - 8, 0, 16, c.height)
    g.filter = 'none'
    g.fillRect(c.width * 0.43 + 8, 0, c.width, c.height)
    // Low-amplitude texture on the right half: strong masking should leave it
    // alone rather than amplifying sensor-like speckle.
    const image = g.getImageData(Math.floor(c.width * 0.62), 0,
      Math.floor(c.width * 0.35), c.height)
    let seed = 123456789
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const d = ((seed >>> 28) - 8) * 0.35
      image.data[i] += d
      image.data[i + 1] += d
      image.data[i + 2] += d
    }
    g.putImageData(image, Math.floor(c.width * 0.62), 0)
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'sharpen.png', mimeType: 'image/png', buffer,
  })
  await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
  await page.waitForTimeout(700)
}

async function setPanelSlider(page, label, value) {
  await page.getByRole('slider', { name: label, exact: true }).evaluate((node, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, String(next))
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await page.waitForTimeout(220)
}

async function energies(page, png) {
  return page.evaluate(async (b64) => {
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
    const score = (r, laplace) => {
      const x0 = Math.max(2, Math.round(r.x0 * width))
      const x1 = Math.min(width - 2, Math.round(r.x1 * width))
      const y0 = Math.max(2, Math.round(r.y0 * height))
      const y1 = Math.min(height - 2, Math.round(r.y1 * height))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const d = laplace
            ? 4 * luma(x, y) - luma(x - 1, y) - luma(x + 1, y)
              - luma(x, y - 1) - luma(x, y + 1)
            : luma(x + 1, y) - luma(x - 1, y)
          sum += d * d
          n++
        }
      }
      return n ? sum / n : 0
    }
    return {
      edge: score({ x0: 0.35, x1: 0.52, y0: 0.18, y1: 0.82 }, false),
      noise: score({ x0: 0.66, x1: 0.94, y0: 0.18, y1: 0.82 }, true),
    }
  }, png.toString('base64'))
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
  await upload(page, await sharpPng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForTimeout(400)

  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()
  const baseEnergy = await energies(page, before)
  await setPanelSlider(page, '锐化', 100)
  await setPanelSlider(page, '锐化半径', 40)
  await setPanelSlider(page, '锐化蒙版', 100)
  await page.waitForTimeout(450)
  const masked = await canvas.screenshot()
  const maskedEnergy = await energies(page, masked)
  check('锐化后强边缘细节上升', maskedEnergy.edge > baseEnergy.edge * 1.03,
    `edge ${baseEnergy.edge.toFixed(1)} → ${maskedEnergy.edge.toFixed(1)}`)
  check('高蒙版保留低幅噪声区', maskedEnergy.noise < baseEnergy.noise * 1.45,
    `noise ${baseEnergy.noise.toFixed(1)} → ${maskedEnergy.noise.toFixed(1)}`)

  await setPanelSlider(page, '锐化蒙版', 0)
  await page.waitForTimeout(350)
  const unmasked = await canvas.screenshot()
  const unmaskedEnergy = await energies(page, unmasked)
  check('关闭蒙版后平面噪声更容易被放大', unmaskedEnergy.noise > maskedEnergy.noise * 1.05,
    `masked=${maskedEnergy.noise.toFixed(1)} unmasked=${unmaskedEnergy.noise.toFixed(1)}`)

  await setPanelSlider(page, '锐化蒙版', 100)
  await setPanelSlider(page, '锐化半径', 0)
  await page.waitForTimeout(350)
  const smallRadius = await canvas.screenshot()
  await setPanelSlider(page, '锐化半径', 100)
  await page.waitForTimeout(350)
  const largeRadius = await canvas.screenshot()
  const radiusDiff = await meanAbsDiff(page, smallRadius, largeRadius)
  check('锐化半径真的改变采样范围', radiusDiff > 0.05,
    `meanAbsDiff=${radiusDiff.toFixed(3)}`)

  await setPanelSlider(page, '锐化', 0)
  await page.waitForTimeout(400)
  const reset = await canvas.screenshot()
  const resetDiff = await meanAbsDiff(page, before, reset)
  check('锐化强度归零后画面完全复原', resetDiff < 0.05,
    `meanAbsDiff=${resetDiff.toFixed(3)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  check('390px 锐化半径与蒙版可达且不横向溢出',
    await page.getByRole('slider', { name: '锐化半径', exact: true }).isVisible()
      && await page.getByRole('slider', { name: '锐化蒙版', exact: true }).isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  check('锐化控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 锐化探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
