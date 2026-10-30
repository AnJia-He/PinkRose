#!/usr/bin/env node
/**
 * 自动透视验收（WebKit / 390px）。
 *
 * 上传一张确定性的梯形建筑图 → 进「裁剪 → 透视」→ 点「自动透视」，
 * 确认四个角真的落在检测到的左右竖边上 → 应用后画面改变；
 * 同时检查手机宽度不横向溢出、控制台无错误。
 */
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.PERSPECTIVE_BASE ?? 'http://localhost:5173'
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
}

async function architecturePng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const g = c.getContext('2d')
    if (!g) throw new Error('测试图画布不可用')
    const sky = g.createLinearGradient(0, 0, 0, c.height)
    sky.addColorStop(0, '#20364b')
    sky.addColorStop(1, '#0c1118')
    g.fillStyle = sky
    g.fillRect(0, 0, c.width, c.height)
    g.strokeStyle = '#eef3f7'
    g.lineWidth = 8
    g.lineCap = 'round'
    const line = (x0, x1) => {
      g.beginPath()
      g.moveTo(c.width * x0, 0)
      g.lineTo(c.width * x1, c.height)
      g.stroke()
    }
    line(0.28, 0.16)
    line(0.72, 0.84)
    g.strokeStyle = 'rgba(238,243,247,.45)'
    g.lineWidth = 4
    for (let y = 0.18; y < 0.9; y += 0.18) {
      const left = 0.28 - 0.12 * y
      const right = 0.72 + 0.12 * y
      g.beginPath()
      g.moveTo(c.width * left, c.height * y)
      g.lineTo(c.width * right, c.height * y)
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
          name: 'perspective-e2e.png',
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
  throw new Error('30 秒内没把自动透视测试图传上去')
}

async function handleXs(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('.perspective')
    if (!(layer instanceof HTMLElement)) return null
    const width = layer.getBoundingClientRect().width
    if (width <= 0) return null
    return [...layer.querySelectorAll('.perspective-handle')].map(handle => {
      const left = Number.parseFloat(handle.style.left) || 0
      const top = Number.parseFloat(handle.style.top) || 0
      return { x: left / width, y: top / layer.getBoundingClientRect().height }
    })
  })
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

const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  await upload(page, await architecturePng(page))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.tool-row-main [aria-label="裁剪"]', { timeout: 10_000 })
  await page.locator('.tool-row-main [aria-label="裁剪"]').click()
  await page.getByRole('button', { name: '透视', exact: true }).click()
  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()

  const auto = page.getByRole('button', { name: '自动透视', exact: true })
  check('透视第二行有「自动透视」', await auto.count() === 1, `count=${await auto.count()}`)
  await auto.click()
  await page.waitForFunction(() => {
    const layer = document.querySelector('.perspective')
    if (!(layer instanceof HTMLElement)) return false
    const width = layer.getBoundingClientRect().width
    const height = layer.getBoundingClientRect().height
    const handles = [...layer.querySelectorAll('.perspective-handle')]
    if (handles.length !== 4 || width <= 0 || height <= 0) return false
    const xs = handles.map(handle => (Number.parseFloat(handle.style.left) || 0) / width)
    return xs[0] > 0.05 && xs[1] < 0.95 && xs[2] > xs[1] + 0.1 && xs[3] < xs[0] - 0.1
  }, null, { timeout: 10_000 })
  const points = await handleXs(page)
  const topWidth = points ? points[1].x - points[0].x : 0
  const bottomWidth = points ? points[2].x - points[3].x : 0
  check('自动透视识别到向下张开的左右竖边',
    !!points && topWidth > 0.3 && bottomWidth > topWidth + 0.05,
    points ? `top=${topWidth.toFixed(3)} bottom=${bottomWidth.toFixed(3)}` : 'no handles')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth)
  const apply = page.getByRole('button', { name: '应用透视', exact: true })
  check('390px 自动透视面板不横向溢出且应用可达',
    !overflow && await apply.isVisible() && await apply.isEnabled(),
    `overflow=${overflow} visible=${await apply.isVisible()} enabled=${await apply.isEnabled()}`)
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(250)

  await apply.click()
  await page.locator('.tool-row-second').waitFor({ state: 'detached', timeout: 30_000 })
  await page.waitForTimeout(400)
  const after = await canvas.screenshot()
  const diff = await meanAbsDiff(page, before, after)
  check('应用自动透视后画面真的改变', diff > 0.5, `meanAbsDiff=${diff.toFixed(3)}`)

  await upload(page, readFileSync(PORTRAIT))
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.tool-row-main [aria-label="裁剪"]', { timeout: 10_000 })
  await page.locator('.tool-row-main [aria-label="裁剪"]').click()
  await page.getByRole('button', { name: '透视', exact: true }).click()
  await page.getByRole('button', { name: '自动透视', exact: true }).click()
  await page.waitForFunction(() => {
    const notice = [...document.querySelectorAll('.notice')]
      .some(node => node.textContent?.includes('没找到明显的左右竖线'))
    const layer = document.querySelector('.perspective')
    if (!(layer instanceof HTMLElement)) return notice
    const width = layer.getBoundingClientRect().width
    const xs = [...layer.querySelectorAll('.perspective-handle')].map(handle =>
      (Number.parseFloat(handle.style.left) || 0) / Math.max(1, width))
    return notice || (xs.length === 4 && xs.some(x => x > 0.03 && x < 0.97))
  }, null, { timeout: 10_000 })
  const portraitPoints = await handleXs(page)
  const portraitNotice = await page.evaluate(() =>
    [...document.querySelectorAll('.notice')]
      .some(node => node.textContent?.includes('没找到明显的左右竖线')))
  const identity = !!portraitPoints
    && Math.abs(portraitPoints[0].x) < 0.02
    && Math.abs(portraitPoints[1].x - 1) < 0.02
    && Math.abs(portraitPoints[2].x - 1) < 0.02
    && Math.abs(portraitPoints[3].x) < 0.02
  check('普通正脸照不被误判成建筑透视',
    identity && portraitNotice,
    `identity=${identity} notice=${portraitNotice}`)
  check('自动透视流程控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.error('❌ 自动透视探针中途失败：', e instanceof Error ? e.message : e)
  const diagnostic = await page.evaluate(() => ({
    buttonTexts: [...document.querySelectorAll('.tool-row-second button')]
      .map(node => node.textContent?.trim()),
    notices: [...document.querySelectorAll('.notice')].map(node => node.textContent?.trim()),
    handles: [...document.querySelectorAll('.perspective-handle')].map(node => ({
      left: node.style.left,
      top: node.style.top,
    })),
  })).catch(() => null)
  if (diagnostic) console.error('页面状态：', JSON.stringify(diagnostic))
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
