#!/usr/bin/env node
/**
 * 高光 / 阴影裁切警告验收（WebKit / 390px）。
 *
 * 合成一张带纯白、纯黑、中间调区域的照片：
 *   ① 高光警告把纯白区域标红，暗部保持原样；
 *   ② 阴影警告把纯黑区域标蓝；
 *   ③ 提示只在独立覆盖层，主画布导出字节保持不变；
 *   ④ 390px 不横向溢出、控制台无错误。
 */
import { webkit } from 'playwright'

const APP = process.env.CLIPPING_APP ?? 'http://localhost:5173'
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
    }, { name: 'clipcheck', password: 'clip-check-only', email: 'clipcheck@example.com' })
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
    g.fillStyle = '#7b8792'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#ffffff'
    g.fillRect(c.width * 0.08, c.height * 0.28, c.width * 0.24, c.height * 0.30)
    g.fillStyle = '#000000'
    g.fillRect(c.width * 0.68, c.height * 0.28, c.width * 0.24, c.height * 0.30)
    g.fillStyle = '#b28462'
    g.fillRect(c.width * 0.40, c.height * 0.32, c.width * 0.20, c.height * 0.22)
    return c.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function upload(page, buffer) {
  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles({
    name: 'clipping-e2e.png',
    mimeType: 'image/png',
    buffer,
  })
  await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
  await page.waitForTimeout(700)
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
    const x0 = Math.max(0, Math.round(region.x0 * c.width))
    const x1 = Math.min(c.width, Math.round(region.x1 * c.width))
    const y0 = Math.max(0, Math.round(region.y0 * c.height))
    const y1 = Math.min(c.height, Math.round(region.y1 * c.height))
    const d = g.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
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
    const pixels = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = 160
      c.height = 160
      const g = c.getContext('2d')
      g.drawImage(bmp, 0, 0, 160, 160)
      return g.getImageData(0, 0, 160, 160).data
    }
    const da = await pixels(a)
    const db = await pixels(b)
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
  await upload(page, await testPng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.zoom-bar', { timeout: 10_000 })
  const canvas = page.locator('canvas.canvas')
  const high = page.getByRole('button', { name: '高光裁切警告', exact: true })
  const low = page.getByRole('button', { name: '阴影裁切警告', exact: true })
  check('调色画布提供高光 / 暗部裁切警告',
    await high.count() === 1 && await low.count() === 1,
    `high=${await high.count()} low=${await low.count()}`)

  const cleanUrl = await canvas.evaluate(node => node.toDataURL())
  const before = await canvas.screenshot()
  await high.click()
  await page.waitForSelector('.canvas-clipping', { timeout: 5_000 })
  await page.waitForTimeout(300)
  const highShot = await canvas.screenshot()
  const white = await meanColor(page, highShot, { x0: 0.10, x1: 0.28, y0: 0.32, y1: 0.54 })
  check('高光警告把纯白区域标红', white.r > white.g + 70,
    `rgb=${white.r.toFixed(1)},${white.g.toFixed(1)},${white.b.toFixed(1)}`)

  const warnedUrl = await canvas.evaluate(node => node.toDataURL())
  check('警告不污染主画布 / 导出字节', cleanUrl === warnedUrl,
    `same=${cleanUrl === warnedUrl}`)

  await high.click()
  await low.click()
  await page.waitForTimeout(300)
  const lowShot = await canvas.screenshot()
  const black = await meanColor(page, lowShot, { x0: 0.70, x1: 0.90, y0: 0.32, y1: 0.54 })
  check('暗部警告把纯黑区域标蓝', black.b > black.r + 70,
    `rgb=${black.r.toFixed(1)},${black.g.toFixed(1)},${black.b.toFixed(1)}`)

  await low.click()
  await page.waitForTimeout(250)
  const restored = await canvas.screenshot()
  const diff = await meanAbsDiff(page, before, restored)
  check('关闭裁切警告后画面恢复', diff < 0.2, `meanAbsDiff=${diff.toFixed(3)}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  check('390px 裁切警告按钮可见且不溢出',
    await high.isVisible() && await low.isVisible()
      && !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'visible=true overflow=false')
  check('裁切警告流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 裁切警告探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
