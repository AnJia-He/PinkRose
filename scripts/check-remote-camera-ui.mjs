#!/usr/bin/env node
/**
 * Canon CCAPI web configuration probe (WebKit, phone + desktop).
 *
 * The camera bridge is mocked at the network boundary so this checks the
 * product UI and request shape without needing a camera or a real bridge.
 */
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'

const APP = process.env.CANON_UI_APP ?? 'http://localhost:5173'
const BRIDGE = 'http://127.0.0.1:8788'
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

function json(body, status = 200) {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-pinkrose-camera,x-pinkrose-bridge-token',
      'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  }
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
}

async function openFreshWelcome(page) {
  const deadline = Date.now() + 20_000
  let clearSince = 0
  while (Date.now() < deadline) {
    const canvas = await page.locator('canvas.canvas').count()
    const bridge = page.getByRole('button', { name: '相机桥', exact: true })
    if (!canvas && await bridge.count() && await bridge.isVisible()) {
      if (!clearSince) clearSince = Date.now()
      if (Date.now() - clearSince >= 1_500) return
    } else {
      clearSince = 0
      const fresh = page.getByRole('button', { name: '新的一张', exact: true })
      if (await fresh.count() && await fresh.isVisible()) {
        await fresh.click({ timeout: 2_000 }).catch(() => {})
      }
    }
    await page.waitForTimeout(200)
  }
  throw new Error('20 秒内没有回到欢迎页')
}

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
let configured = null
let shutterRequests = 0
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))
await page.route(`${BRIDGE}/**`, async route => {
  const request = route.request()
  if (request.method() === 'OPTIONS') {
    await route.fulfill(json({}, 204))
    return
  }
  const url = new URL(request.url())
  if (url.pathname === '/api/camera/capture') shutterRequests++
  if (url.pathname === '/api/camera/health') {
    await route.fulfill(json({ ok: true, count: 0, converters: [] }))
    return
  }
  if (url.pathname === '/api/camera/photos') {
    await route.fulfill(json({ photos: [] }))
    return
  }
  if (url.pathname === '/api/camera/provider') {
    configured = JSON.parse(request.postData() || '{}')
    const sony = configured?.kind === 'sony-camera'
    await route.fulfill(json({
      ok: true,
      control: {
        connected: true,
        model: sony ? 'Sony Alpha 7C' : 'Canon EOS R7',
        capabilities: {
          liveView: false,
          shutter: true,
          settings: false,
          import: true,
        },
        canConfigure: true,
      },
    }))
    return
  }
  if (url.pathname === '/api/camera/control') {
    const sony = configured?.kind === 'sony-camera'
    await route.fulfill(json({
      connected: configured !== null,
      model: configured === null ? null : sony ? 'Sony Alpha 7C' : 'Canon EOS R7',
      capabilities: configured === null
        ? { liveView: false, shutter: false, settings: false }
        : {
          liveView: false,
          shutter: true,
          settings: false,
          import: true,
        },
      canConfigure: true,
    }))
    return
  }
  await route.fulfill(json({ ok: false, error: 'unexpected mock request' }, 404))
})

try {
  await prepare(page)
  await openFreshWelcome(page)
  errors.length = 0
  await page.getByRole('button', { name: '相机桥', exact: true }).click()
  await page.locator('[aria-label="相机桥地址"]').fill(BRIDGE)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  const mode = page.locator('[aria-label="无线相机连接方式"]')
  await mode.waitFor({ state: 'visible', timeout: 10_000 })
  check('390px 有无线连接方式选择', await mode.isVisible(), 'visible')
  check('默认仍是 PTP/IP gphoto2', await mode.inputValue() === 'gphoto2',
    `mode=${await mode.inputValue()}`)

  await mode.selectOption('canon-ccapi')
  await page.locator('[aria-label="Canon CCAPI 地址"]').fill('192.168.1.60')
  await page.locator('[aria-label="相机端口"]').fill('8080')
  await page.getByRole('button', { name: '连接无线相机', exact: true }).click()
  await page.getByText('已连接 Canon CCAPI').waitFor({ state: 'visible', timeout: 5_000 })
  check('网页提交标准化的 Canon CCAPI 配置',
    configured?.kind === 'canon-ccapi' && configured?.url === 'http://192.168.1.60:8080',
    JSON.stringify(configured))
  check('390px 显示相机型号', (await page.locator('.bridge-body').innerText()).includes('Canon EOS R7'),
    'Canon EOS R7')
  check('Canon 能力支持时显示从相机导入',
    await page.getByRole('button', { name: '从相机导入', exact: true }).count() === 1,
    '可见')
  await page.locator('[aria-label="相机连接名称"]').fill('影棚 Canon')
  await page.getByRole('button', { name: '保存当前', exact: true }).click()
  check('可以保存当前 Canon 连接并显示自定义名称',
    await page.getByRole('button', { name: '连接 影棚 Canon', exact: true }).count() === 1,
    '影棚 Canon')
  const savedProfiles = await page.evaluate(() =>
    localStorage.getItem('pinkrose.camera.connections.v1') ?? '')
  check('连接配置只写本机且不含访问令牌',
    savedProfiles.includes('影棚 Canon') && !savedProfiles.includes('"token"'),
    savedProfiles.includes('影棚 Canon') ? '已持久化，无 token 字段' : '未写入')
  await page.getByRole('button', { name: '检查相机', exact: true }).click()
  const diagnostics = page.locator('[aria-label="相机检测结果"]')
  await diagnostics.waitFor({ state: 'visible', timeout: 5_000 })
  check('只读检测逐项报告桥、机身、取景、控制、导入和转换器',
    await diagnostics.locator('li').count() === 6
      && (await diagnostics.innerText()).includes('Canon EOS R7')
      && (await page.locator('.bridge-diagnostics-bar').innerText()).includes('不会按快门'),
    (await diagnostics.innerText()).replace(/\s+/g, ' ').slice(0, 180))
  check('相机检测没有触发快门', shutterRequests === 0,
    `capture requests=${shutterRequests}`)
  check('390px 没有横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'scrollWidth <= viewport')

  await mode.selectOption('sony-camera')
  await page.locator('[aria-label="Sony Camera Remote 地址"]').fill('192.168.1.70')
  await page.locator('[aria-label="相机端口"]').fill('')
  await page.getByRole('button', { name: '连接无线相机', exact: true }).click()
  await page.getByText('已连接 Sony Camera Remote').waitFor({ state: 'visible', timeout: 5_000 })
  check('网页提交 Sony Camera Remote 配置',
    configured?.kind === 'sony-camera' && configured?.url === 'http://192.168.1.70:10000',
    JSON.stringify(configured))
  check('Sony 能力支持时也显示从相机导入',
    await page.getByRole('button', { name: '从相机导入', exact: true }).count() === 1,
    '可见')
  await page.locator('[aria-label="相机连接名称"]').fill('外景 Sony')
  await page.getByRole('button', { name: '保存当前', exact: true }).click()
  check('多台相机配置同时保留',
    await page.getByRole('button', { name: '连接 影棚 Canon', exact: true }).count() === 1
      && await page.getByRole('button', { name: '连接 外景 Sony', exact: true }).count() === 1,
    '2 台')
  const [profilesDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 10_000 }),
    page.getByRole('button', { name: '导出相机连接配置', exact: true }).click(),
  ])
  const profilesPath = await profilesDownload.path()
  if (!profilesPath) throw new Error('相机配置导出没有下载路径')
  const exportedProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'))
  check('导出相机配置且文件不含访问令牌',
    exportedProfiles.version === 1
      && exportedProfiles.connections?.length === 2
      && !JSON.stringify(exportedProfiles).includes('token'),
    profilesDownload.suggestedFilename())
  await page.locator('input[accept*=".json"]').setInputFiles({
    name: 'camera-profiles.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      connections: [{
        kind: 'gphoto2',
        address: '192.168.1.80',
        port: '',
        label: '备用 PTP',
      }],
    })),
  })
  await page.getByRole('button', { name: '连接 备用 PTP', exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 })
  check('导入配置后出现新的相机入口', true, '备用 PTP')
  await page.getByRole('button', { name: '连接 影棚 Canon', exact: true }).click()
  await page.getByText('已连接 Canon CCAPI').waitFor({ state: 'visible', timeout: 5_000 })
  check('点保存的配置可直接切回那台相机',
    configured?.kind === 'canon-ccapi' && configured?.url === 'http://192.168.1.60:8080',
    JSON.stringify(configured))
  await page.getByRole('button', { name: '删除 外景 Sony', exact: true }).click()
  check('删除连接配置只删列表项',
    await page.getByRole('button', { name: '连接 外景 Sony', exact: true }).count() === 0
      && await page.getByRole('button', { name: '连接 影棚 Canon', exact: true }).count() === 1
      && await page.getByRole('button', { name: '连接 备用 PTP', exact: true }).count() === 1,
    'Sony 已删 / Canon 和备用 PTP 保留')

  await page.setViewportSize({ width: 1024, height: 900 })
  check('桌面宽度没有横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'scrollWidth <= viewport')
  check('浏览器控制台无错误', errors.length === 0, errors.join(' | ') || '无错误')
} finally {
  await browser.close()
}

const failed = checks.filter(item => !item.ok)
console.log('')
console.log(failed.length === 0
  ? `✅ ${checks.length}/${checks.length} 条通过`
  : `❌ ${failed.length}/${checks.length} 条失败`)
if (failed.length > 0) process.exit(1)
