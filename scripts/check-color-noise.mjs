#!/usr/bin/env node
/**
 * 彩色降噪验收（WebKit / 390px）。
 *
 * 合成一张带高频红蓝斑点、同时有清晰明暗方格的测试图：
 *   ① 彩色降噪 100 后，红蓝方差明显下降；
 *   ② 亮度方差基本保留，证明没有把整张图糊掉；
 *   ③ 归零后画面逐像素复原；
 *   ④ 390px 控件可达、无横向溢出。
 */
import { webkit } from 'playwright'

const APP = process.env.COLOR_NOISE_APP ?? 'http://localhost:5173'
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

async function noisyPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 720
    c.height = 480
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    const image = g.createImageData(c.width, c.height)
    let seed = 0x9e3779b9
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0xffffffff
    }
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const base = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 190 : 70
        const chroma = (random() * 2 - 1) * 42
        const r = Math.max(0, Math.min(255, base + chroma))
        const b = Math.max(0, Math.min(255, base - chroma))
        const greenShift = 0.1963 * chroma
        const green = Math.max(0, Math.min(255, base - greenShift))
        const i = (y * c.width + x) * 4
        image.data[i] = r
        image.data[i + 1] = green
        image.data[i + 2] = b
        image.data[i + 3] = 255
      }
    }
    g.putImageData(image, 0, 0)
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'color-noise.png',
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
  await page.waitForTimeout(220)
}

async function variance(page, png) {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const r = g.getImageData(
      Math.round(c.width * 0.2), Math.round(c.height * 0.2),
      Math.round(c.width * 0.6), Math.round(c.height * 0.6),
    ).data
    let luma = 0
    let luma2 = 0
    let chroma = 0
    let chroma2 = 0
    let n = 0
    for (let i = 0; i < r.length; i += 4) {
      const y = 0.2126 * r[i] + 0.7152 * r[i + 1] + 0.0722 * r[i + 2]
      const cb = (r[i + 2] - y) - (r[i] - y)
      luma += y
      luma2 += y * y
      chroma += cb
      chroma2 += cb * cb
      n++
    }
    const lumaMean = luma / n
    const chromaMean = chroma / n
    return {
      luma: luma2 / n - lumaMean * lumaMean,
      chroma: chroma2 / n - chromaMean * chromaMean,
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
  await upload(page, await noisyPng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForTimeout(400)

  const slider = page.getByRole('slider', { name: '彩色降噪', exact: true })
  check('细节组提供独立的彩色降噪滑杆', await slider.count() === 1,
    `count=${await slider.count()}`)

  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()
  const beforeVar = await variance(page, before)
  await setPanelSlider(page, '彩色降噪', 100)
  await page.waitForTimeout(450)
  const after = await canvas.screenshot()
  const afterVar = await variance(page, after)
  const chromaDrop = 1 - afterVar.chroma / Math.max(1e-6, beforeVar.chroma)
  const lumaKeep = afterVar.luma / Math.max(1e-6, beforeVar.luma)
  check('彩色斑点明显减少', chromaDrop > 0.55,
    `chroma ${beforeVar.chroma.toFixed(1)} → ${afterVar.chroma.toFixed(1)}（-${(chromaDrop * 100).toFixed(1)}%）`)
  check('明暗边缘和亮度纹理基本保留', lumaKeep > 0.9,
    `luma variance ${beforeVar.luma.toFixed(1)} → ${afterVar.luma.toFixed(1)}（${(lumaKeep * 100).toFixed(1)}%）`)

  await setPanelSlider(page, '彩色降噪', 0)
  await page.waitForTimeout(400)
  const reset = await canvas.screenshot()
  const resetDiff = await meanAbsDiff(page, before, reset)
  check('归零后画面完全复原', resetDiff < 0.05, `meanAbsDiff=${resetDiff.toFixed(3)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  check('390px 彩色降噪可达且不横向溢出',
    await slider.isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  check('彩色降噪流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 彩色降噪探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
