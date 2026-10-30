#!/usr/bin/env node
/**
 * 焦点包围 → 焦点堆栈验收（WebKit / 390px）。
 *
 * 用 Playwright 拦截一个“暴露 manualfocusdrive 的相机桥”，不依赖真实硬件：
 *   ① 焦点控件只在相机给出可写焦点位置时出现；
 *   ② 拍 3 张，焦点依次移动并恢复；
 *   ③ 整组照片直接预填到焦点堆栈工作区。
 */
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = process.env.FOCUS_BRACKET_APP ?? 'http://localhost:5173'
const BRIDGE = 'http://127.0.0.1:8792'
const JPEG = readFileSync(fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url)))
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
    }, { name: 'safaricheck', password: 'safari-check-only', email: 'safaricheck@example.com' })
    if (status !== 200 && status !== 'login') throw new Error(`测试账号登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  const deadline = Date.now() + 20_000
  let clearSince = 0
  while (Date.now() < deadline) {
    const bridge = page.getByRole('button', { name: '相机桥', exact: true })
    if (!(await page.locator('canvas.canvas').count()) && await bridge.count() && await bridge.isVisible()) {
      if (!clearSince) clearSince = Date.now()
      if (Date.now() - clearSince >= 2_000) return
    } else {
      clearSince = 0
      const fresh = page.getByRole('button', { name: '新的一张', exact: true })
      if (await fresh.count() && await fresh.isVisible()) await fresh.click().catch(() => {})
    }
    await page.waitForTimeout(250)
  }
  throw new Error('20 秒内没有回到欢迎页')
}

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
let focus = 50
let shots = 0
const focusPuts = []
page.on('console', message => {
  if (message.type() === 'error') {
    errors.push(`${message.text()} ${message.location().url}`.trim())
  }
})
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => {
  if (response.status() >= 400 && response.url().startsWith(BRIDGE)) {
    errors.push(`HTTP ${response.status()} ${response.url()}`)
  }
})

const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
}

await page.route(`${BRIDGE}/api/camera/**`, async route => {
  const request = route.request()
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers })
    return
  }
  const url = new URL(request.url())
  const path = url.pathname
  const json = (body) => route.fulfill({
    status: 200,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (path === '/api/camera/health') return json({ ok: true, count: shots })
  if (path === '/api/camera/control') {
    return json({
      connected: true,
      model: 'Focus Mock',
      capabilities: { liveView: false, shutter: true, settings: true },
      settingsSchema: [
        {
          key: 'focusMode', label: '对焦模式', type: 'select',
          options: [{ value: 'MF', label: 'MF' }, { value: 'AF', label: 'AF' }],
        },
        {
          key: 'manualfocusdrive', label: '手动对焦位置',
          type: 'number', min: 0, max: 100, step: 1,
        },
      ],
    })
  }
  if (path === '/api/camera/settings') {
    if (request.method() === 'PUT') {
      const body = JSON.parse(request.postData() || '{}')
      if (typeof body.manualfocusdrive === 'number') {
        focus = body.manualfocusdrive
        focusPuts.push(focus)
      }
    }
    return json({ settings: { focusMode: 'MF', manualfocusdrive: focus } })
  }
  if (path === '/api/camera/shutter') {
    shots++
    return json({ ok: true, result: { saved: `focus-${shots}.jpg` } })
  }
  if (path === '/api/camera/photos') {
    return json({
      photos: Array.from({ length: shots }, (_, index) => ({
        id: `focus-${index + 1}.jpg`,
        name: `focus-${index + 1}.jpg`,
        size: JPEG.length,
        mtime: index + 1,
        type: 'image/jpeg',
        url: `/api/camera/file?id=focus-${index + 1}.jpg`,
      })),
    })
  }
  if (path === '/api/camera/file') {
    return route.fulfill({
      status: 200,
      headers: { ...headers, 'content-type': 'image/jpeg' },
      body: JPEG,
    })
  }
  return route.fulfill({ status: 404, headers, body: 'not found' })
})

try {
  await prepare(page)
  errors.length = 0
  await page.getByRole('button', { name: '相机桥', exact: true }).click()
  await page.locator('[aria-label="相机桥地址"]').fill(BRIDGE)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '焦点包围', exact: true }).waitFor({
    state: 'visible', timeout: 10_000,
  })
  check('相机暴露可写焦点时才出现焦点包围',
    await page.locator('[aria-label="焦点包围"]').count() === 1,
    `group=${await page.locator('[aria-label="焦点包围"]').count()}`)

  await page.getByRole('button', { name: '焦点包围', exact: true }).click()
  const stack = page.getByRole('button', { name: '用这组做焦点堆栈', exact: true })
  await stack.waitFor({ state: 'visible', timeout: 10_000 })
  check('焦点包围拍 3 张并恢复原焦点',
    shots === 3 && focusPuts.join(',') === '45,50,55,50',
    `shots=${shots} focus=${focusPuts.join(',')}`)

  await stack.click()
  await page.getByRole('heading', { name: '焦点堆栈', exact: true }).waitFor({
    state: 'visible', timeout: 20_000,
  })
  await page.waitForFunction(() => document.querySelectorAll('.batch-file-row').length === 3, null, {
    timeout: 15_000,
  })
  check('整组照片直接预填焦点堆栈',
    await page.locator('.batch-file-row').count() === 3,
    `files=${await page.locator('.batch-file-row').count()}`)
  check('390px 不横向溢出',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')
  check('控制台 / 页面错误',
    errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 焦点包围探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
