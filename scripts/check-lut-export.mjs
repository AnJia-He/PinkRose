#!/usr/bin/env node
/**
 * 当前外观 → .cube 的 WebKit 端到端验收。
 *
 *   ① 先在全零参数下生成，下载并确认灰色条目 = 0.5（恒等）；
 *   ② 把色温拉到 100，重新生成，确认同一灰色条目变暖；
 *   ③ 把色调拉到 100，确认同一灰色条目偏洋红；
 *   ④ 文件头、33³ 条目数和 390px 布局都对。
 *
 * 先起开发服务器，再跑：
 *   npm run check:lut-export
 */
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.LUT_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const SIZE = 33
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
    if (status !== 200 && status !== 'login') throw new Error(`测试账号登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.evaluate(async () => {
    try {
      const res = await fetch('/api/sessions', { credentials: 'same-origin' })
      if (!res.ok) return
      const list = await res.json()
      const rows = Array.isArray(list) ? list : (list.sessions ?? [])
      for (const row of rows) {
        await fetch(`/api/sessions/${row.id}`, {
          method: 'DELETE', credentials: 'same-origin',
        })
      }
    } catch { /* 未登录 / 离线：后面按正常路径等上传框 */ }
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForLoadState('networkidle')
}

async function uploadPortrait(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(400)
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) {
      try {
        await page.locator('input[type="file"]').first()
          .setInputFiles(PORTRAIT, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(800)
        return
      } catch { /* 恢复刚好抢走上传框，重试 */ }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('30 秒内没把测试图传上去')
}

async function generateAndDownload(page) {
  await page.getByRole('button', { name: '生成 .cube', exact: true }).click()
  const downloadButton = page.getByRole('button', { name: '下载 .cube', exact: true })
  try {
    await downloadButton.waitFor({ state: 'visible', timeout: 30_000 })
  } catch (e) {
    console.log('   生成后状态：', (await page.locator('.look-export').innerText()).replace(/\s+/g, ' '))
    throw e
  }
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadButton.click(),
  ])
  const path = await download.path()
  if (!path) throw new Error('下载没有落到临时文件')
  return readFileSync(path, 'utf8')
}

function cubeEntry(text, r, g, b) {
  const lines = text.trim().split('\n')
  const index = 5 + b * SIZE * SIZE + g * SIZE + r
  return lines[index].split(/\s+/).map(Number)
}

let browser
try {
  browser = await webkit.launch()
} catch (e) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
  const context = await browser.newContext({
    viewport: { width: 1000, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))

  try {
    await prepare(page)
    errors.length = 0
    await uploadPortrait(page)
    await page.locator('.nav-item', { hasText: '调色' }).first().click()
    await page.waitForSelector('.panel', { timeout: 10_000 })
    await page.locator('.panel-group-head').filter({ hasText: 'Lut' }).first().click()
    await page.waitForSelector('.look-export', { timeout: 10_000 })

    const identity = await generateAndDownload(page)
    const lines = identity.trim().split('\n')
    check('恒等 LUT：文件头与 33³ 条目数', lines[2] === 'LUT_3D_SIZE 33'
      && lines.length === 5 + SIZE ** 3,
      `size=${lines[2]} entries=${lines.length - 5}`)
    const identityGray = cubeEntry(identity, 16, 16, 16)
    check('恒等 LUT：灰色条目为 0.5',
      identityGray.every(v => Math.abs(v - 0.501961) < 0.01),
      identityGray.map(v => v.toFixed(4)).join(' / '))

    const temp = page.locator('.panel label.slider')
      .filter({ has: page.locator('.slider-label', { hasText: '色温' }) })
    await temp.locator('input[type="range"]').focus()
    await page.keyboard.press('End')
    await page.waitForFunction(() => {
      const label = [...document.querySelectorAll('.panel label.slider')]
        .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '色温')
      return label?.querySelector('.slider-value')?.textContent?.trim() === '100'
    }, null, { timeout: 5_000 })
    await page.waitForTimeout(300)

    const warm = await generateAndDownload(page)
    const warmGray = cubeEntry(warm, 16, 16, 16)
    check('色温 100 后重新生成：同一灰色条目变暖',
      warmGray[0] - warmGray[2] > 0.1,
      warmGray.map(v => v.toFixed(4)).join(' / '))

    await temp.locator('input[type="range"]').evaluate((node) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(node, '0')
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() => {
      const label = [...document.querySelectorAll('.panel label.slider')]
        .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '色温')
      return label?.querySelector('.slider-value')?.textContent?.trim() === '0'
    }, null, { timeout: 5_000 })
    const tint = page.locator('.panel label.slider')
      .filter({ has: page.locator('.slider-label', { hasText: '色调' }) })
    await tint.locator('input[type="range"]').focus()
    await page.keyboard.press('End')
    await page.waitForTimeout(300)
    const magenta = await generateAndDownload(page)
    const magentaGray = cubeEntry(magenta, 16, 16, 16)
    check('色调 100 后重新生成：同一灰色条目偏洋红',
      magentaGray[1] < magentaGray[0] - 0.005
        && magentaGray[1] < magentaGray[2] - 0.005,
      magentaGray.map(v => v.toFixed(4)).join(' / '))

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    check('390px 下 LUT 导出块不撑破布局',
      !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
      'overflow=false')
    check('控制台无错误', errors.length === 0,
      errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

    const failed = checks.filter(c => !c.ok)
    console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
    if (failed.length) process.exitCode = 1
  } catch (e) {
    console.error('❌ LUT 导出探针中途失败：', e instanceof Error ? e.message : e)
    if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
    process.exitCode = 1
  } finally {
    await browser.close()
  }
