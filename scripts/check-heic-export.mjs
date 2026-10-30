#!/usr/bin/env node
/**
 * HEIC 导出能力探针（WebKit）。
 *
 * 不假设每台机器都装了 HEIC 编码器：先问真实服务端能力，再确认网页里的
 * HEIC 选项与能力一致。有编码器时还要能选中；没有时这个选项必须完全隐藏。
 *
 *   npm run check:heic
 */
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.env.HEIC_BASE ?? 'http://localhost:5173'
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
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      })
      if (login.ok) return 'login'
      const signup = await fetch('/api/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, email, password }),
      })
      return signup.status
    }, { name: 'safaricheck', password: 'safari-check-only', email: 'safaricheck@example.com' })
    if (status !== 200 && status !== 'login') {
      throw new Error(`测试账号登录/注册失败：HTTP ${status}`)
    }
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 15_000 }).catch(() => {}),
  ])
}

async function uploadPortrait(page) {
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
        await page.locator('input[type="file"]').first()
          .setInputFiles(PORTRAIT, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        return
      } catch {
        // 会话恢复可能刚好换掉上传框，回到循环重开一张。
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error('30 秒内没有上传测试照片')
}

let browser
try {
  browser = await webkit.launch()
} catch (error) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  const capability = await page.evaluate(async () => {
    const res = await fetch('/api/convert/heic/capability', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    return res.ok ? await res.json() : { available: false, encoder: null }
  })
  await uploadPortrait(page)
  await page.locator('.export-settings > summary').click()
  const option = page.locator('input[name="export-format"][value="image/heic"]')
  check('HEIC 选项与真实编码器能力一致',
    capability.available ? await option.count() === 1 : await option.count() === 0,
    `server=${Boolean(capability.available)} encoder=${capability.encoder ?? 'none'} option=${await option.count()}`)

  if (capability.available) {
    await option.check()
    check('HEIC 可以被选中', await option.isChecked(), `checked=${await option.isChecked()}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  check('iPhone 宽度下 HEIC 选项不把面板撑出屏幕',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')

  await page.locator('.nav-item', { hasText: '作品' }).first().click()
  await page.locator('.gallery-batch').click()
  await page.locator('.batch-page').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.batch-page .export-settings > summary').click()
  const batchOption = page.locator(
    '.batch-page input[name="export-format"][value="image/heic"]')
  check('批量页 HEIC 选项与真实编码器能力一致',
    capability.available ? await batchOption.count() === 1 : await batchOption.count() === 0,
    `server=${Boolean(capability.available)} option=${await batchOption.count()}`)
  if (capability.available) {
    await batchOption.check()
    check('批量 HEIC 可以被选中', await batchOption.isChecked(),
      `checked=${await batchOption.isChecked()}`)
  }
  check('批量页 390px 不横向溢出',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')

  check('没有控制台错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')
  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ HEIC 探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
