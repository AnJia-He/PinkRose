#!/usr/bin/env node
/**
 * 双色调真浏览器探针（★ 2026-10-19）。
 *
 * 走一遍：登录 → 上传 → 调色 → 装饰 → 双色调 → 切紫夜 → 应用。
 * 重点看三件事：预览真的画出了像素、390px 第二行不折行、应用后工具收掉。
 * 用法：先 `npm run dev`，再 `npm run check:duotone`。
 */
import { chromium, webkit } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.env.DUOTONE_BASE ?? 'http://localhost:5173'
const APP = `${BASE}/app`
const PHOTO = fileURLToPath(new URL('../test-photos/e2e_first_use.jpg', import.meta.url))
const checks = []

function check(name, ok, got) {
  checks.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function signIn(page) {
  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 20_000 })
  if (await page.locator('.login-box').count()) {
    const status = await page.evaluate(async () => {
      const body = {
        username: 'safaricheck',
        password: 'safari-check-only',
        email: 'safaricheck@example.com',
      }
      const login = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (login.ok) return 'login'
      const signup = await fetch('/api/signup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return signup.status
    })
    if (status !== 'login' && status !== 200) throw new Error(`登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle').catch(() => {})
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(300)
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) return
    await page.waitForTimeout(250)
  }
  throw new Error('没有走到可上传的那一屏')
}

async function upload(page) {
  await page.locator('input[type="file"]').first().setInputFiles(PHOTO)
  await page.waitForSelector('canvas.canvas', { timeout: 20_000 })
  await page.waitForTimeout(800)
}

function sampleScript() {
  const canvas = document.querySelector('.duotone-canvas')
  if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) {
    return { width: 0, height: 0, samples: [] }
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return { width: canvas.width, height: canvas.height, samples: [] }
  const samples = [0.25, 0.5, 0.75].map(fraction => {
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(canvas.width * fraction)))
    const y = Math.max(0, Math.round(canvas.height / 2))
    return [...ctx.getImageData(x, y, 1, 1).data]
  })
  return { width: canvas.width, height: canvas.height, samples }
}

async function run(browserType, label) {
  const browser = await browserType.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await signIn(page)
    await upload(page)
    await page.locator('.nav-item', { hasText: '调色' }).first().click()
    await page.waitForTimeout(400)
    await page.locator('.tool-cell', { hasText: '装饰' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '双色调', exact: true }).click()
    await page.waitForSelector('.duotone-canvas', { timeout: 10_000 })
    await page.waitForTimeout(500)

    const before = await page.evaluate(sampleScript)
    check(`${label} 双色调预览有像素`, before.width > 0 && before.height > 0
      && before.samples.some(pixel => pixel[3] > 0),
      `${before.width}x${before.height} samples=${JSON.stringify(before.samples)}`)

    await page.getByRole('button', { name: '紫夜', exact: true }).click()
    await page.waitForTimeout(400)
    const after = await page.evaluate(sampleScript)
    const changed = JSON.stringify(before.samples) !== JSON.stringify(after.samples)
    check(`${label} 切换预设后预览变色`, changed,
      `before=${JSON.stringify(before.samples)} after=${JSON.stringify(after.samples)}`)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    const layout = await page.evaluate(() => {
      const row = document.querySelector('.tool-row-second')?.getBoundingClientRect()
      const done = [...document.querySelectorAll('.crop-tools button')]
        .find(button => (button.textContent ?? '').trim() === '应用双色调')
        ?.getBoundingClientRect()
      return {
        rowHeight: row?.height ?? 0,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        doneVisible: !!done && done.right <= innerWidth + 1 && done.left >= -1,
      }
    })
    check(`${label} 390px 第二行不折行`, layout.rowHeight > 0 && layout.rowHeight <= 64,
      `rowHeight=${layout.rowHeight}`)
    check(`${label} 390px 页面不横向溢出`, !layout.overflow, `overflow=${layout.overflow}`)
    check(`${label} 390px 应用按钮可达`, layout.doneVisible, `doneVisible=${layout.doneVisible}`)

    await page.getByRole('button', { name: '应用双色调', exact: true }).click()
    await page.waitForTimeout(700)
    const closed = await page.evaluate(() =>
      !document.querySelector('.duotone-preview') && !document.querySelector('.tool-row-second'))
    check(`${label} 应用后预览和工具都收掉`, closed, `closed=${closed}`)

    // 批量页：同一套双色调也能整批套；390px 下预设 / 取色器不能被挤出屏幕。
    await page.locator('.nav-item', { hasText: '作品' }).first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: '批量处理', exact: true }).click()
    await page.waitForSelector('#batch-duotone-title', { timeout: 10_000 })
    await page.locator('input[name="batch-duotone"]').check()
    await page.waitForTimeout(300)
    const batch = await page.evaluate(() => ({
      section: !!document.querySelector('#batch-duotone-title'),
      chips: !!document.querySelector('.batch-chip-row'),
      colors: !!document.querySelector('.batch-duotone-colors'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }))
    check(`${label} 批量页双色调控件可见`, batch.section && batch.chips && batch.colors,
      `section=${batch.section} chips=${batch.chips} colors=${batch.colors}`)
    check(`${label} 批量页 390px 不横向溢出`, !batch.overflow, `overflow=${batch.overflow}`)
    // 登录墙之前的 401 / 未登录时拉滤镜清单，是这一屏的正常噪声；
    // 这里只盯双色调相关的运行时错误。
    const relevant = errors.filter(text =>
      !/401|Unauthorized|先登录一下/.test(text))
    check(`${label} 控制台无错误`, relevant.length === 0,
      relevant.length ? relevant.slice(0, 3).join(' | ') : '无')
  } finally {
    await browser.close()
  }
}

for (const [browserType, label] of [[chromium, 'Chromium'], [webkit, 'WebKit']]) {
  try {
    await run(browserType, label)
  } catch (error) {
    check(`${label} 探针执行完成`, false, error instanceof Error ? error.message : String(error))
  }
}

const failed = checks.filter(item => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 条通过`)
if (failed.length) process.exit(1)
