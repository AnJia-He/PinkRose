#!/usr/bin/env node
/**
 * 相机桥实时取景辅助探针（WebKit / 390px）。
 *
 * 先启动模拟相机桥：
 *   npm run camera:bridge -- --port 8792 --mock-live test-photos/e2e_portrait.jpg
 * 再运行：
 *   npm run check:camera-live
 */
import { webkit } from 'playwright'

const APP = process.env.CAMERA_LIVE_APP ?? 'http://localhost:5173'
const BRIDGE = process.env.CAMERA_LIVE_BRIDGE ?? 'http://127.0.0.1:8792'
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
    if (status !== 200 && status !== 'login') throw new Error(`测试账号登录失败：HTTP ${status}`)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3_500)
}

async function openFreshWelcome(page) {
  const deadline = Date.now() + 20_000
  let clearSince = 0
  while (Date.now() < deadline) {
    const canvas = await page.locator('canvas.canvas').count()
    const bridge = page.getByRole('button', { name: '相机桥', exact: true })
    if (!canvas && await bridge.count() && await bridge.isVisible()) {
      if (!clearSince) clearSince = Date.now()
      if (Date.now() - clearSince >= 2_000) return
    } else {
      clearSince = 0
      const fresh = page.getByRole('button', { name: '新的一张', exact: true })
      if (await fresh.count() && await fresh.isVisible()) {
        await fresh.click({ timeout: 2_000 }).catch(() => {})
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error('20 秒内没有回到稳定的欢迎页')
}

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  await openFreshWelcome(page)
  errors.length = 0
  await page.getByRole('button', { name: '相机桥', exact: true }).click()
  await page.locator('[aria-label="相机桥地址"]').fill(BRIDGE)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  const canvas = page.locator('.camera-live-view canvas[aria-label="相机实时取景"]')
  await canvas.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => {
    const item = document.querySelector('.camera-live-view canvas')
    return item instanceof HTMLCanvasElement && item.width > 0 && item.height > 0
  }, null, { timeout: 15_000 })

  const group = page.getByRole('group', { name: '取景辅助' })
  const grid = group.getByRole('button', { name: '网格', exact: true })
  const peaking = group.getByRole('button', { name: '对焦峰值', exact: true })
  const zebra = group.getByRole('button', { name: '斑马纹', exact: true })
  const falseColor = group.getByRole('button', { name: '伪色', exact: true })
  const histogram = group.getByRole('button', { name: '直方图', exact: true })
  check('实时取景五项辅助都在',
    await grid.count() === 1 && await peaking.count() === 1
      && await zebra.count() === 1 && await falseColor.count() === 1
      && await histogram.count() === 1,
    '网格 / 对焦峰值 / 斑马纹 / 伪色 / 直方图')
  check('构图网格默认开启', await grid.getAttribute('aria-pressed') === 'true',
    `grid=${await grid.getAttribute('aria-pressed')}`)
  await peaking.click()
  await zebra.click()
  await falseColor.click()
  await histogram.click()
  await page.waitForTimeout(700)
  check('对焦峰值、斑马纹和直方图可以切换',
    await peaking.getAttribute('aria-pressed') === 'true'
      && await zebra.getAttribute('aria-pressed') === 'true'
      && await falseColor.getAttribute('aria-pressed') === 'true'
      && await histogram.getAttribute('aria-pressed') === 'true',
    'peaking=true zebra=true falseColor=true histogram=true')
  const zoomGroup = page.getByRole('group', { name: '实时取景放大' })
  const zoom2 = zoomGroup.getByRole('button', { name: '2×', exact: true })
  await zoom2.click()
  check('对焦放大可切到 2×', await zoom2.getAttribute('aria-pressed') === 'true',
    `2x=${await zoom2.getAttribute('aria-pressed')}`)
  const dims = await canvas.evaluate(item => ({ w: item.width, h: item.height }))
  check('实时画面有真实尺寸', dims.w > 0 && dims.h > 0, `${dims.w}x${dims.h}`)

  await zoomGroup.getByRole('button', { name: '1×', exact: true }).click()
  const loupeButton = zoomGroup.getByRole('button', { name: '100% 对焦放大镜', exact: true })
  await loupeButton.click()
  const loupeCanvas = page.locator('.camera-loupe canvas[aria-label="100% 对焦放大镜画面"]')
  await loupeCanvas.waitFor({ state: 'visible', timeout: 5_000 })
  const loupeDims = await loupeCanvas.evaluate(item => ({ w: item.width, h: item.height }))
  check('100% 对焦放大镜显示原生像素大小的画面',
    await loupeButton.getAttribute('aria-pressed') === 'true'
      && loupeDims.w > 0 && loupeDims.h > 0 && loupeDims.w <= 320 && loupeDims.h <= 200,
    `${loupeDims.w}x${loupeDims.h}`)
  const loupeBefore = await loupeCanvas.screenshot()
  const photoBox = await canvas.boundingBox()
  if (!photoBox) throw new Error('实时取景画布没有可点击区域')
  await page.mouse.click(
    photoBox.x + photoBox.width * 0.3,
    photoBox.y + photoBox.height * 0.7,
  )
  await page.waitForTimeout(300)
  const loupeAfter = await loupeCanvas.screenshot()
  check('点主画面可以移动 100% 放大镜观察点',
    Buffer.compare(loupeBefore, loupeAfter) !== 0,
    `${loupeBefore.length}B -> ${loupeAfter.length}B`)

  const fullscreen = zoomGroup.getByRole('button', { name: '全屏取景', exact: true })
  await fullscreen.click()
  const expanded = page.locator('.camera-live-frame.expanded')
  check('实时取景可铺满视口并安全退出',
    await expanded.count() === 1
      && await zoomGroup.getByRole('button', { name: '退出全屏取景', exact: true }).count() === 1,
    `expanded=${await expanded.count()}`)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.camera-live-frame.expanded'))
  const interval = page.locator('[aria-label="间隔拍摄"]')
  check('间隔拍摄控件可用',
    await interval.count() === 1
      && await interval.locator('input[aria-label="间隔拍摄张数"]').count() === 1
      && await interval.locator('input[aria-label="间隔拍摄秒数"]').count() === 1
      && await interval.getByRole('button', { name: '间隔拍摄', exact: true }).count() === 1,
    `group=${await interval.count()}`)
  const bracket = page.locator('[aria-label="包围曝光"]')
  check('包围曝光控件可用',
    await bracket.count() === 1
      && await bracket.locator('select[aria-label="包围曝光张数"]').count() === 1
      && await bracket.locator('select[aria-label="包围曝光步长"]').count() === 1
      && await bracket.getByRole('button', { name: '包围曝光', exact: true }).count() === 1,
    `group=${await bracket.count()}`)
  check('390px 不横向溢出',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')
  check('控制台 / 页面错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')
  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 相机实时取景探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
