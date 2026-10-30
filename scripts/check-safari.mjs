#!/usr/bin/env node
/**
 * Safari / iPhone 兼容探针（★ 2026-10-18）。
 *
 * 用 Playwright 的 WebKit 内核（和 iPhone Safari 同源）跑一条真实用户路径：
 * 落地页 → 注册 → 上传 → 调色 → 实时直方图 → 文字工具。
 * 重点看四件事：WebGL2、Safari 的 CSS 能力、390px 不横向溢出、控制台无错。
 *
 * 第一次跑要先装浏览器：
 *   npx playwright install webkit
 * 然后起开发服务器（npm run dev），再跑：
 *   npm run check:safari
 */
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const BASE = process.env.SAFARI_BASE ?? 'http://localhost:5173'
const APP = `${BASE}/app`
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

/** 批量 ZIP 是 store-only；从 local header 里找出 `.tif` 并读前四个字节。 */
function zipTiffHeader(path) {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressed = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const data = offset + 30 + nameLength + extraLength
    if (name.endsWith('.tif')) {
      return { name, header: [...bytes.subarray(data, data + 4)] }
    }
    offset = data + compressed
  }
  return null
}

function tiffCompression(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x49 || bytes[1] !== 0x49) return null
  const ifd = bytes.readUInt32LE(4)
  if (ifd + 2 > bytes.length) return null
  const count = bytes.readUInt16LE(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > bytes.length) return null
    if (bytes.readUInt16LE(entry) === 259) return bytes.readUInt16LE(entry + 8)
  }
  return null
}

function tiffIccProfile(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x49 || bytes[1] !== 0x49) return null
  const ifd = bytes.readUInt32LE(4)
  if (ifd + 2 > bytes.length) return null
  const count = bytes.readUInt16LE(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > bytes.length) return null
    if (bytes.readUInt16LE(entry) === 34675) {
      const size = bytes.readUInt32LE(entry + 4)
      const offset = bytes.readUInt32LE(entry + 8)
      return bytes.subarray(offset, offset + size)
    }
  }
  return null
}

function tiffAsciiTag(bytes, tag) {
  const start = bytes.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  if (start + 8 > bytes.length) return null
  const tiff = bytes.subarray(start)
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!little && !big) return null
  const u16 = offset => big ? tiff.readUInt16BE(offset) : tiff.readUInt16LE(offset)
  const u32 = offset => big ? tiff.readUInt32BE(offset) : tiff.readUInt32LE(offset)
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return null
    if (u16(entry) !== tag || u16(entry + 2) !== 2) continue
    const length = u32(entry + 4)
    const offset = length <= 4 ? entry + 8 : u32(entry + 8)
    if (offset + length > tiff.length) return null
    return tiff.subarray(offset, offset + length).toString('latin1').replace(/\0+$/, '')
  }
  return null
}

function pngExif(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, i) => bytes[i] === value)) return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const end = offset + 12 + length
    if (end > bytes.length) return null
    if (type === 'eXIf') return bytes.subarray(offset + 8, offset + 8 + length)
    offset = end
  }
  return null
}

function pngIccProfile(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, i) => bytes[i] === value)) return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const end = offset + 12 + length
    if (end > bytes.length) return null
    if (type === 'iCCP') {
      const data = bytes.subarray(offset + 8, offset + 8 + length)
      const nul = data.indexOf(0)
      if (nul < 0 || data[nul + 1] !== 0) return null
      return inflateSync(data.subarray(nul + 2))
    }
    offset = end
  }
  return null
}

function looksLikeIcc(profile) {
  return !!profile && profile.length > 128
    && profile.subarray(36, 40).toString('ascii') === 'acsp'
    && profile.subarray(16, 20).toString('ascii') === 'RGB '
}

async function prepare(page) {
  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    // 固定测试账号：先登录，账号不存在时才注册。每跑一次就新建一个账号会把
    // 注册限流打满（连续调试时 429），也会让 dev 库越堆越多。
    const who = 'safaricheck'
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
    }, { name: who, password: 'safari-check-only', email: `${who}@example.com` })
    if (status !== 200 && status !== 'login') {
      throw new Error(`Safari 测试账号登录/注册失败：HTTP ${status}`)
    }
    // 这个账号会被反复跑探针用到；每次都让产品先恢复上次的会话，既慢又会
    // 和「新的一张」抢 DOM（连续调试时实测会把准备阶段拖过 20 秒）。探针
    // 不需要任何历史数据，登录后先清空，跑起来的是一条干净路径。
    await page.evaluate(async () => {
      const res = await fetch('/api/sessions', { credentials: 'same-origin' })
      const list = await res.json()
      const rows = Array.isArray(list) ? list : (list.sessions ?? [])
      for (const row of rows) {
        await fetch(`/api/sessions/${row.id}`, {
          method: 'DELETE', credentials: 'same-origin',
        })
      }
    })
    await page.reload({ waitUntil: 'load' })
  }
  // 固定账号可能带着上一次探针的会话。等自动恢复落地后先开「新的一张」，
  // 否则紧接着上传会与恢复赛跑，探针会把产品正常的“恢复作废”日志当成错误。
  await page.waitForLoadState('networkidle')
  // networkidle 只说明网络停了；恢复还要逐张解码头像/步骤图、生成缩略图，
  // 这段时间里「新的一张」已经可见。此时点它会正常地作废这次恢复 ——
  // 产品按设计在 console.error 留痕，控制台判据就会误伤。
  // 等两条“可以安全动手”的信号之一：恢复结束的那句通报，或本来就没有可恢复会话
  // （恢复期间 `busy` 会把上传器整个藏起来，所以「有上传框且没画布」不会提前成立）。
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 20_000 }).catch(() => {}),
  ])
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(400)
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) {
      await page.waitForTimeout(500)
      if (await page.locator('input[type="file"]').count()
        && !(await page.locator('canvas.canvas').count())) {
        // 「新的一张」可能落在两种空态：调色屏（`.adjust-empty`）或欢迎页
        // （`.welcome`）。后面的实时相机入口只住在欢迎页，所以这里把目的地
        // 说死；否则探针会在调色空态里找一个永远不出现的按钮。
        if (!(await page.locator('.welcome').count())) {
          const home = page.locator('.nav-item', { hasText: '修图' }).first()
          if (await home.count()) await home.click()
          await page.waitForSelector('.welcome input[type="file"]', { timeout: 10_000 })
        }
        return
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error('20 秒内没走到可上传的那一屏')
}

async function uploadBands(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 600
    c.height = 300
    const g = c.getContext('2d')
    g.fillStyle = 'rgb(0,0,0)'
    g.fillRect(0, 0, 200, 300)
    g.fillStyle = 'rgb(128,128,128)'
    g.fillRect(200, 0, 200, 300)
    g.fillStyle = 'rgb(255,255,255)'
    g.fillRect(400, 0, 200, 300)
    return c.toDataURL('image/png')
  })
  const file = {
    name: 'safari-bands.png', mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
  }
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
        await page.locator('input[type="file"]').first().setInputFiles(file, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(700)
        return
      } catch {
        // 会话恢复可能刚好把上传框换掉；回到循环重开一张再传。
      }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('30 秒内没把测试横图传上去')
}

let browser
try {
  browser = await webkit.launch()
} catch (e) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
// 这条探针要验浏览器真实下载 TIFF；headless WebKit 不弹系统分享面板，
// 固定走「下载」那一格，免得分享能力探测把下载入口换掉。
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true })
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
})
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

try {
  // ① 访客落地页
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.waitForSelector('h1', { timeout: 15_000 })
  const landing = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim() ?? '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('WebKit 内核', (await page.evaluate(() => navigator.userAgent)).includes('AppleWebKit'),
    (await page.evaluate(() => navigator.userAgent)).slice(0, 60))
  check('落地页可打开', landing.title.length > 0 && !landing.overflow,
    `标题「${landing.title.slice(0, 20)}」 overflow=${landing.overflow}`)

  const pwa = await page.evaluate(async () => {
    const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? ''
    const apple = {
      capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content') ?? '',
      status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content') ?? '',
      title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content') ?? '',
      icon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? '',
    }
    const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
    let manifest = null
    if (manifestHref) {
      try {
        const r = await fetch(manifestHref)
        if (r.ok) manifest = await r.json()
      } catch { /* 下面按缺失报出来 */ }
    }
    return { manifestHref, manifest, apple, viewport }
  })
  check('Web App Manifest', !!pwa.manifest
    && pwa.manifest.display === 'standalone'
    && pwa.manifest.start_url === '/app'
    && Array.isArray(pwa.manifest.icons)
    && pwa.manifest.icons.length >= 2,
    pwa.manifest
      ? `start=${pwa.manifest.start_url} display=${pwa.manifest.display} icons=${pwa.manifest.icons?.length ?? 0}`
      : `href=${pwa.manifestHref || '缺少'}`)
  check('iOS 主屏元数据', pwa.apple.capable === 'yes'
    && pwa.apple.status === 'default'
    && pwa.apple.title === 'PinkRose'
    && pwa.apple.icon.endsWith('.png'),
    `capable=${pwa.apple.capable || '缺少'} status=${pwa.apple.status || '缺少'} `
      + `title=${pwa.apple.title || '缺少'} icon=${pwa.apple.icon || '缺少'}`)
  check('iOS 安全区 viewport-fit=cover', pwa.viewport.includes('viewport-fit=cover'), pwa.viewport)

  await prepare(page)
  errors.length = 0   // 登录墙之前的 401 不算这一页的错误
  const caps = await page.evaluate(() => ({
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
    imageBitmap: typeof createImageBitmap === 'function',
    path2d: typeof Path2D === 'function',
    lightDark: CSS.supports('color', 'light-dark(#000, #fff)'),
  }))
  check('WebGL2', caps.webgl2, String(caps.webgl2))
  check('createImageBitmap', caps.imageBitmap, String(caps.imageBitmap))
  check('Path2D', caps.path2d, String(caps.path2d))
  check('light-dark()（现代 Safari 主题基线）', caps.lightDark, String(caps.lightDark))

  // 实时相机：入口能开、权限/设备失败时给出提示，弹层不把 390px 撑宽。
  // 欢迎页有入场动画，滤镜 / 预设清单也可能刚好回来触发一次重渲染；
  // Playwright 的"等元素稳定"会因此一直等不到同一个节点。入口行为本身
  // 不依赖动画稳定，force 跳过这一层即可。
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '实时相机', exact: true })
    .click({ force: true, timeout: 5_000 })
  await page.waitForSelector('.camera-dialog', { timeout: 15_000 })
  await Promise.race([
    page.waitForSelector('.camera-stage video', { timeout: 5_000 }).catch(() => {}),
    page.waitForSelector('.camera-error', { timeout: 5_000 }).catch(() => {}),
  ])
  const camera = await page.evaluate(() => ({
    title: document.querySelector('#camera-title')?.textContent?.trim() ?? '',
    hasVideo: !!document.querySelector('.camera-stage video'),
    hasError: !!document.querySelector('.camera-error'),
    close: !!document.querySelector('[aria-label="关闭相机"]'),
    hasRecord: [...document.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').trim() === '录像'),
    frames: [...document.querySelectorAll('.camera-toggles button')]
      .map(b => (b.textContent ?? '').trim())
      .filter(text => ['原始', '1:1', '4:5', '3:4', '16:9', '9:16'].includes(text)),
    countdowns: [...document.querySelectorAll('.camera-toggles button')]
      .map(b => (b.textContent ?? '').trim())
      .filter(text => ['即时', '3 秒', '5 秒', '10 秒'].includes(text)),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('实时相机入口可打开 / 失败有提示', camera.title === '实时相机'
    && camera.close && (camera.hasVideo || camera.hasError),
    `video=${camera.hasVideo} error=${camera.hasError} close=${camera.close}`)
  check('实时相机有录像入口', camera.hasRecord, `record=${camera.hasRecord}`)
  check('实时相机有六种成片画幅', camera.frames.length === 6,
    `frames=${camera.frames.join(' / ')}`)
  check('实时相机倒计时到 10 秒', camera.countdowns.length === 4,
    `countdowns=${camera.countdowns.join(' / ')}`)
  check('实时相机弹层 390px 不横向溢出', !camera.overflow,
    `overflow=${camera.overflow}`)
  // 相机权限失败后弹层会重试重渲染，Playwright 的稳定性等待可能等不到同一个节点；
  // 这里只验关闭动作接上了，直接在 DOM 上点一次即可。
  await page.evaluate(() =>
    document.querySelector('[aria-label="关闭相机"]')?.click())
  await page.waitForSelector('.camera-dialog', { state: 'detached', timeout: 5_000 })

  // 相机桥是按需加载的第二块；没有桥进程时也应打开安装 / 地址说明，而不是空白。
  const bridgeErrorStart = errors.length
  await page.getByRole('button', { name: '相机桥', exact: true })
    .click({ force: true, timeout: 5_000 })
  await page.waitForSelector('[aria-label="关闭相机桥"]', { timeout: 15_000 })
  const bridge = await page.evaluate(() => ({
    copy: document.querySelector('.bridge-body')?.textContent ?? '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('相机桥按需加载后可打开', bridge.copy.includes('npm run camera:bridge'), '安装说明可见')
  check('相机桥弹层 390px 不横向溢出', !bridge.overflow, `overflow=${bridge.overflow}`)
  await page.evaluate(() =>
    document.querySelector('[aria-label="关闭相机桥"]')?.click())
  await page.waitForSelector('[aria-label="关闭相机桥"]', { state: 'detached', timeout: 5_000 })
  const bridgeErrors = errors.splice(bridgeErrorStart)
  check('相机桥未运行时只产生可恢复的连接提示',
    bridgeErrors.every(text => text.includes('连不上服务器') || text.includes('相机桥')),
    bridgeErrors.length ? bridgeErrors.slice(0, 2).join(' | ') : '无错误')

  await uploadBands(page)

  // iPhone / iPad：两根手指在照片区拉开 → 画面必须真的放大。
  // jsdom 那套只验数学和接线；这里验 WebKit 的 PointerEvent + React 手势链。
  await page.evaluate(async () => {
    const wrap = document.querySelector('.canvas-wrap')
    const r = wrap.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const fire = (target, type, id, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: id, pointerType: 'touch', isPrimary: id === 1,
    }))
    fire(wrap, 'pointerdown', 1, cx - 40, cy)
    fire(wrap, 'pointerdown', 2, cx + 40, cy)
    fire(window, 'pointermove', 1, cx - 100, cy)
    fire(window, 'pointermove', 2, cx + 100, cy)
    fire(window, 'pointerup', 1, cx - 100, cy)
    fire(window, 'pointerup', 2, cx + 100, cy)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const pinchTransform = await page.locator('canvas.canvas').evaluate(el => el.style.transform)
  const pinchScale = Number(/scale\(([\d.]+)\)/.exec(pinchTransform)?.[1] ?? 0)
  check('双指缩放', pinchScale > 1.5, pinchTransform || '没有产生缩放变换')
  await page.locator('.zoom-fit').click()

  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
  await page.waitForSelector('.histogram svg path', { timeout: 10_000 })

  const before = await page.evaluate(() => ({
    paths: [...document.querySelectorAll('.histogram svg path')].map(p => p.getAttribute('d') ?? ''),
    text: document.querySelector('.histogram')?.textContent ?? '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  const clip = [...before.text.matchAll(/(暗部|高光) ([\d.]+)%/g)].map(m => Number(m[2]))
  check('直方图三条通道', before.paths.length === 3 && before.paths.every(d => d.includes('L')),
    `${before.paths.length} 条`)
  check('暗部 / 高光溢出读数', clip.length === 2 && clip.every(v => v >= 30 && v <= 40),
    before.text.replace(/\s+/g, ' ').trim())
  check('390px 不横向溢出', !before.overflow, `overflow=${before.overflow}`)

  const copyAdjust = page.getByRole('button', { name: '复制调色', exact: true })
  const pasteAdjust = page.getByRole('button', { name: '粘贴调色', exact: true })
  const clipboardReady = await copyAdjust.count() === 1
    && await pasteAdjust.count() === 1 && await pasteAdjust.isDisabled()
  check('调色剪贴板控件可用',
    clipboardReady
      && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `copy=${await copyAdjust.count()} paste=${await pasteAdjust.count()} ready=${clipboardReady}`)

  // 导出格式里要有 AVIF（Safari 16.4+ 原生支持显示）。
  const exportSummary = page.locator('.export-settings summary').first()
  if (await exportSummary.count()) {
    const opened = await page.evaluate(() =>
      document.querySelector('.export-settings')?.open === true)
    if (!opened) await exportSummary.click()
    await page.waitForTimeout(200)
  }
  const avifFormat = page.locator('input[name="export-format"][value="image/avif"]')
  check('导出格式含 AVIF', await avifFormat.count() === 1,
    `formats=${await page.locator('input[name="export-format"]').count()}`)
  const tiffFormat = page.locator('input[name="export-format"][value="image/tiff"]')
  check('导出格式含 TIFF', await tiffFormat.count() === 1,
    `formats=${await page.locator('input[name="export-format"]').count()}`)
  await page.locator('label.export-choice', { hasText: 'TIFF' }).click()
    const creatorInput = page.locator('input[name="export-creator"]')
    const copyrightInput = page.locator('input[name="export-copyright"]')
    await creatorInput.click()
    await creatorInput.pressSequentially('Photographer A', { delay: 5 })
    await creatorInput.press('Tab')
    await page.waitForTimeout(120)
    await copyrightInput.click()
    await copyrightInput.pressSequentially('(c) 2026 Photographer A', { delay: 5 })
    await copyrightInput.press('Tab')
    await page.waitForTimeout(120)
    const rightsUi = {
      creator: await creatorInput.inputValue(),
      copyright: await copyrightInput.inputValue(),
    }
    check('导出设置保留作者与版权输入',
      rightsUi.creator === 'Photographer A'
        && rightsUi.copyright === '(c) 2026 Photographer A',
      JSON.stringify(rightsUi))
  const watermarkDetails = page.locator('details.export-watermark')
  if (await watermarkDetails.count()) {
    const opened = await watermarkDetails.evaluate(element =>
      element instanceof HTMLDetailsElement && element.open)
    if (!opened) await watermarkDetails.locator('summary').click()
  }
  const watermarkFont = page.locator('select[aria-label="水印字体"]')
  await watermarkFont.selectOption('serif')
  check('WebKit 水印字体可选并与文字工具对齐',
    await watermarkFont.inputValue() === 'serif'
      && await watermarkFont.locator('option').count() === 4,
    `font=${await watermarkFont.inputValue()} options=${await watermarkFont.locator('option').count()}`)
  await page.waitForTimeout(120)
  await page.evaluate(() => {
    const details = document.querySelector('.export-settings')
    if (details) details.open = false
  })
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: '下载', exact: true }).click()
  const download = await downloadPromise
  await download.saveAs('.superpowers/metadata-check.tif')
  const path = await download.path()
  const tiffBytes = path ? readFileSync(path) : Buffer.alloc(0)
  const head = tiffBytes.subarray(0, 4)
  const compression = tiffCompression(tiffBytes)
  const tiffIcc = tiffIccProfile(tiffBytes)
  const nativeCompression = await page.evaluate(() => typeof CompressionStream !== 'undefined')
  check('TIFF 在 WebKit 里真实下载，压缩策略正确',
    download.suggestedFilename().endsWith('.tif')
      && head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00
      && compression === (nativeCompression ? 8 : 1) && looksLikeIcc(tiffIcc),
    `${download.suggestedFilename()} header=${[...head].map(v => v.toString(16).padStart(2, '0')).join(' ')}`
      + ` compression=${compression} native=${nativeCompression} icc=${tiffIcc?.length ?? 0}`)
    const tiffCreator = tiffAsciiTag(tiffBytes, 315)
    const tiffCopyright = tiffAsciiTag(tiffBytes, 33432)
    check('TIFF 真实写入作者与版权',
      tiffCreator === 'Photographer A' && tiffCopyright === '(c) 2026 Photographer A',
      `artist=${tiffCreator ?? '（空）'} copyright=${tiffCopyright ?? '（空）'}`)

  // PNG：WebKit 真实导出的 iCCP 必须能被 Node 解压回 ICC。
  await exportSummary.click()
  await page.locator('label.export-choice', { hasText: 'PNG' }).click()
    const pngRightsUi = {
      creator: await creatorInput.inputValue(),
      copyright: await copyrightInput.inputValue(),
    }
    check('切换格式后作者与版权不丢',
      pngRightsUi.creator === 'Photographer A'
        && pngRightsUi.copyright === '(c) 2026 Photographer A',
      JSON.stringify(pngRightsUi))
  await page.waitForTimeout(120)
  const profileNote = await page.locator('.color-profile-note').textContent()
  check('PNG 导出设置说明写入 sRGB ICC', !!profileNote?.includes('内嵌 sRGB ICC'),
    profileNote?.trim() ?? 'missing note')
  const pngMetadata = page.locator('input[name="export-metadata"]')
  check('PNG 导出可保留拍摄信息', await pngMetadata.count() === 1 && await pngMetadata.isChecked(),
    `count=${await pngMetadata.count()} checked=${await pngMetadata.isChecked().catch(() => false)}`)

  await page.locator('label.export-choice', { hasText: 'WebP' }).click()
  await page.waitForTimeout(120)
  const webpMetadata = page.locator('input[name="export-metadata"]')
  check('WebP 导出可保留拍摄信息', await webpMetadata.count() === 1 && await webpMetadata.isChecked(),
    `count=${await webpMetadata.count()} checked=${await webpMetadata.isChecked().catch(() => false)}`)

  const locationSwitch = page.locator('input[name="export-location"]')
  check('拍摄信息可单独关闭 GPS',
    await locationSwitch.count() === 1 && await locationSwitch.isChecked(),
    `count=${await locationSwitch.count()} checked=${await locationSwitch.isChecked().catch(() => false)}`)
  await locationSwitch.click()
  check('GPS 开关能独立关闭', !(await locationSwitch.isChecked()),
    `checked=${await locationSwitch.isChecked()}`)
  await locationSwitch.click()

  await page.locator('label.export-choice', { hasText: 'PNG' }).click()
  await page.waitForTimeout(120)
  await page.evaluate(() => {
    const details = document.querySelector('.export-settings')
    if (details) details.open = false
  })
  const pngDownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: '下载', exact: true }).click()
  const pngDownload = await pngDownloadPromise
  await pngDownload.saveAs('.superpowers/metadata-check.png')
  const pngPath = await pngDownload.path()
  const pngBytes = pngPath ? readFileSync(pngPath) : Buffer.alloc(0)
  const pngIcc = pngIccProfile(pngBytes)
  check('PNG 在 WebKit 里真实下载并内嵌 ICC', pngDownload.suggestedFilename().endsWith('.png')
    && looksLikeIcc(pngIcc),
    `${pngDownload.suggestedFilename()} icc=${pngIcc?.length ?? 0}`)
    const pngRights = pngExif(pngBytes)
    const pngCreator = pngRights ? tiffAsciiTag(pngRights, 315) : null
    const pngCopyright = pngRights ? tiffAsciiTag(pngRights, 33432) : null
    check('PNG eXIf 真实写入作者与版权',
      pngCreator === 'Photographer A' && pngCopyright === '(c) 2026 Photographer A',
      `artist=${pngCreator ?? '（空）'} copyright=${pngCopyright ?? '（空）'}`)

  // Display P3：真实走一遍像素转换和 iCCP 写入。
  await exportSummary.click()
  await page.locator('label.export-choice', { hasText: 'Display P3' }).click()
  await page.waitForTimeout(120)
  const p3Note = await page.locator('.color-profile-note').textContent()
  check('Display P3 导出说明不冒充广色域编辑',
    !!p3Note?.includes('内嵌 Display P3 ICC') && p3Note.includes('不会恢复超出 sRGB'),
    p3Note?.trim() ?? 'missing note')
  await page.evaluate(() => {
    const details = document.querySelector('.export-settings')
    if (details) details.open = false
  })
  const p3DownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: '下载', exact: true }).click()
  const p3Download = await p3DownloadPromise
  const p3Path = await p3Download.path()
  const p3Bytes = p3Path ? readFileSync(p3Path) : Buffer.alloc(0)
  const p3Icc = pngIccProfile(p3Bytes)
  check('Display P3 PNG 在 WebKit 里真实带 P3 ICC',
    p3Download.suggestedFilename().endsWith('.png')
      && looksLikeIcc(p3Icc)
      && Buffer.from(p3Icc ?? []).toString('latin1').includes('Display P3'),
    `${p3Download.suggestedFilename()} icc=${p3Icc?.length ?? 0}`)

  // 同一张图一次生成四个平台比例，真实下载一个 ZIP；解开中央目录里的文件名核对。
  await page.evaluate(() => {
    const details = document.querySelector('.export-settings')
    if (details) details.open = true
  })
  const socialDownloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
  await page.getByRole('button', { name: '全部打包', exact: true }).click()
  const socialDownload = await socialDownloadPromise
  const socialPath = await socialDownload?.path()
  const socialBytes = socialPath ? readFileSync(socialPath) : Buffer.alloc(0)
  const socialText = socialBytes.toString('utf8')
  const socialIds = ['xiaohongshu', 'moments', 'weibo', 'vertical']
  const socialNotice = await page.locator('.notice').textContent().catch(() => '')
  check('WebKit 一次打包四种社交尺寸',
    !!socialDownload
      && socialDownload.suggestedFilename().includes('社交尺寸.zip')
      && socialBytes[0] === 0x50 && socialBytes[1] === 0x4b
      && socialIds.every(id => socialText.includes(`-${id}.jpg`)),
    `${socialDownload?.suggestedFilename() ?? '没有下载'} bytes=${socialBytes.length}`
      + ` entries=${socialIds.filter(id => socialText.includes(`-${id}.jpg`)).length}`
      + ` notice=${socialNotice?.trim() ?? ''} errors=${errors.slice(0, 2).join(' | ')}`)

  // 面板展开后会盖住摘要（.export-sheet），直接收起，别再点一次。
  await page.evaluate(() => {
    const details = document.querySelector('.export-settings')
    if (details) details.open = false
  })

  await page.getByRole('button', { name: '我的预设', exact: true }).click()
  const xmpInput = page.locator('.my-presets-file')
  check('我的预设支持 XMP 导入入口',
    (await xmpInput.getAttribute('accept') ?? '').includes('.xmp'),
    `accept=${await xmpInput.getAttribute('accept')}`)
  const xmpDownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: '导出当前 XMP', exact: true }).click()
  const xmpDownload = await xmpDownloadPromise
  const xmpPath = await xmpDownload.path()
  const xmpText = xmpPath ? readFileSync(xmpPath, 'utf8') : ''
  check('当前调色可下载 XMP',
    xmpDownload.suggestedFilename().endsWith('.xmp')
      && xmpText.includes('<x:xmpmeta')
      && xmpText.includes('crs:Exposure2012'),
    `${xmpDownload.suggestedFilename()} bytes=${Buffer.byteLength(xmpText)}`)
  await page.getByRole('button', { name: '我的预设', exact: true }).click()

  const photoInfo = page.getByRole('button', { name: '照片信息', exact: true })
  await photoInfo.click()
  await page.waitForSelector('.photo-info', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.photo-info')?.textContent ?? ''
    return text.includes('文件大小') && text.includes('尺寸') && text.includes('不会上传')
  }, null, { timeout: 10_000 })
  const photoInfoText = await page.locator('.photo-info').innerText()
  check('照片信息可按需展开', photoInfoText.includes('文件大小')
    && photoInfoText.includes('尺寸') && photoInfoText.includes('不会上传'),
    photoInfoText.replace(/\s+/g, ' ').slice(0, 80))
  await photoInfo.click()

  await page.getByRole('button', { name: '波形', exact: true }).click()
  await page.waitForSelector('.scope-wave-band', { timeout: 10_000 })
  const wave = await page.evaluate(() => ({
    band: document.querySelector('.scope-wave-band')?.getAttribute('d') ?? '',
    mid: document.querySelector('.scope-wave-mid')?.getAttribute('d') ?? '',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('亮度波形可用', wave.band.includes('Z') && wave.mid.includes('L') && !wave.overflow,
    `band=${wave.band.length} mid=${wave.mid.length} overflow=${wave.overflow}`)

  await page.getByRole('button', { name: '矢量', exact: true }).click()
  await page.waitForSelector('.scope-vector-point', { timeout: 10_000 })
  const vector = await page.evaluate(() => ({
    points: document.querySelectorAll('.scope-vector-point').length,
    axes: document.querySelectorAll('.scope-axis').length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  check('矢量示波器可用', vector.points > 0 && vector.axes === 2 && !vector.overflow,
    `points=${vector.points} axes=${vector.axes} overflow=${vector.overflow}`)
  await page.getByRole('button', { name: '直方图', exact: true }).click()

  const dusk = page.locator('.rail-tile').filter({ hasText: '黄昏' }).first()
  await dusk.click()
  const presetStrength = page.locator('.panel .slider').filter({
    has: page.locator('.slider-label', { hasText: '黄昏强度' }),
  }).first()
  await presetStrength.waitFor({ state: 'visible', timeout: 10_000 })
  check('预设强度滑杆可用', await dusk.getAttribute('aria-pressed') === 'true'
    && await presetStrength.count() === 1,
    `pressed=${await dusk.getAttribute('aria-pressed')}`)
  await presetStrength.locator('.slider-value').click()
  await presetStrength.locator('input.slider-edit').fill('50')
  await presetStrength.locator('input.slider-edit').press('Enter')
  await page.waitForTimeout(250)
  check('调预设强度后不横向溢出', await dusk.getAttribute('aria-pressed') === 'true'
    && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `pressed=${await dusk.getAttribute('aria-pressed')}`)
  await page.locator('.rail-tile').filter({ hasText: '原图' }).first().click()

  const brightness = page.locator('.panel .slider')
    .filter({ has: page.locator('.slider-label', { hasText: '亮度' }) }).first()
  await brightness.locator('.slider-value').click()
  const input = brightness.locator('input.slider-edit')
  await input.fill('40')
  await input.press('Enter')
  await page.waitForTimeout(350)
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('.histogram svg path')].map(p => p.getAttribute('d') ?? ''))
  check('调亮度后直方图实时更新', after.some((d, i) => d !== before.paths[i]),
    after[0] === before.paths[0] ? '路径没变' : '路径已变')

  // ② 文字工具：Safari 上 Path2D / 画布 / 输入框都要能用
  await page.locator('.tool-row-main [aria-label="文字"]').click()
  await page.waitForSelector('.text-input', { timeout: 10_000 })
  await page.fill('.text-input', 'Safari')
  const textRow = page.locator('.tool-row-second')
  await textRow.getByRole('button', { name: '标题', exact: true }).click()
  const apply = textRow.getByRole('button', { name: '加上文字' })
  check('文字工具可用', await apply.isEnabled(), `按钮 disabled=${!(await apply.isEnabled())}`)
  const fontValue = await textRow.locator('.slider')
    .filter({ has: page.locator('.slider-label', { hasText: '字号' }) })
    .locator('.slider-value').innerText()
  check('文字模板可用', Number(fontValue.trim()) === 30, `字号=${fontValue.trim()}`)
  await textRow.getByRole('button', { name: '取消' }).click()

  // ④ iPhone 横屏：用横图检查 844×390 的矮视口，照片、面板和工具行都要能用。
  await page.setViewportSize({ width: 844, height: 390 })
  await page.waitForTimeout(500)
  const landscape = await page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.x), y: Math.round(r.y),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
      }
    }
    return {
      canvas: box('canvas.canvas'),
      panel: box('.panel'),
      tool: box('.tool-row-main'),
      rail: box('.rail'),
      vw: innerWidth,
      vh: innerHeight,
      docW: document.documentElement.scrollWidth,
    }
  })
  check('iPhone 横屏照片可用', !!landscape.canvas
    && landscape.canvas.w >= 280 && landscape.canvas.h >= 120,
    landscape.canvas ? `${landscape.canvas.w}x${landscape.canvas.h}` : 'missing canvas')
  check('iPhone 横屏面板与工具行在屏内', !!landscape.panel && !!landscape.tool
    && landscape.panel.w > 0 && landscape.tool.right <= landscape.vw + 1,
    landscape.panel
      ? `panel=${landscape.panel.w}x${landscape.panel.h} toolRight=${landscape.tool?.right ?? 'missing'}`
      : 'missing panel')
  check('iPhone 横屏不横向溢出', landscape.docW <= landscape.vw + 1
    && !!landscape.rail && landscape.rail.w > 0,
    `doc=${landscape.docW}/${landscape.vw} rail=${landscape.rail
      ? `${landscape.rail.w}x${landscape.rail.h}` : 'missing'}`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)

  // ⑤ 人像磨皮 / 去斑：真实正脸照片走一遍 WebKit 的检测、控件与预览接线。
  //    这条不提交成片，只证明苹果端能打开、能点、布局不被挤坏；成片路径由
  //    App.tools.test.tsx 的本地引擎断言和 Chromium 布局探针共同守住。
  await page.getByRole('button', { name: '新的一张', exact: true }).click()
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15_000 })
  await page.locator('input[type="file"]').first().setInputFiles(PORTRAIT)
  // WebKit 偶发出现“元素已经可见，但 locator 的可见性等待不返回”的探针毛刺；
  // 这里直接等画布有真实尺寸，避免把探针自身的等待问题误报成产品失败。
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas.canvas')
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
  }, null, { timeout: 15_000 })
  await page.waitForTimeout(700)
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })

  // ⑤a 全局磨皮：调色面板里的滑杆在 iPhone 宽度上要够得着、推得动。
  //     像素级的"皮肤变平 / 睫毛保住"由 scripts/check-smooth.mjs 守，
  //     这里只验 WebKit 上的控件和布局。
  const globalSmooth = page.locator('.panel label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: '磨皮' }) })
  const globalSmoothRange = globalSmooth.locator('input[type="range"]')
  await globalSmoothRange.focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('.panel label.slider')]
      .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '磨皮')
    return label?.querySelector('.slider-value')?.textContent?.trim() === '100'
  }, null, { timeout: 5_000 })
  const globalSmoothValue = await globalSmooth.locator('.slider-value').innerText()
  check('调色面板「磨皮」滑杆在 iPhone 宽度可达', await globalSmooth.count() === 1
    && globalSmoothValue.trim() === '100'
    && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `count=${await globalSmooth.count()} value=${globalSmoothValue.trim()} overflow=false`)
  await globalSmoothRange.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(200)

  await page.locator('.tool-row-main [aria-label="人像"]').click()
  const portraitRow = page.locator('.tool-row-second')
  await portraitRow.waitFor({ state: 'visible', timeout: 15_000 })
  const blemish = portraitRow.getByRole('button', { name: '去斑', exact: true })
  const smoothLabel = portraitRow.locator('.slider-label', { hasText: '磨皮' })
  const whitenLabel = portraitRow.locator('.slider-label', { hasText: '美白' })
  const rosyLabel = portraitRow.locator('.slider-label', { hasText: '红润' })
  const smileLabel = portraitRow.locator('.slider-label', { hasText: '微笑' })
  const crownLabel = portraitRow.locator('.slider-label', { hasText: '颅顶' })
  const legsLabel = portraitRow.locator('.slider-label', { hasText: '长腿' })
  const neckLabel = portraitRow.locator('.slider-label', { hasText: '瘦颈' })
  const doubleChinLabel = portraitRow.locator('.slider-label', { hasText: '双下巴' })
  const shoulderLabel = portraitRow.locator('.slider-label', { hasText: '直角肩' })
  check('人像磨皮 / 肤色 / 去斑 / 颅顶 / 长腿 / 瘦颈 / 双下巴 / 直角肩控件可用', await smoothLabel.count() === 1
    && await whitenLabel.count() === 1 && await rosyLabel.count() === 1
    && await smileLabel.count() === 1
    && await blemish.count() === 1 && await blemish.isEnabled()
    && await crownLabel.count() === 1 && await legsLabel.count() === 1
    && await neckLabel.count() === 1 && await doubleChinLabel.count() === 1
    && await shoulderLabel.count() === 1,
    `磨皮=${await smoothLabel.count()} 美白=${await whitenLabel.count()} 红润=${await rosyLabel.count()} `
      + `微笑=${await smileLabel.count()} 去斑=${await blemish.count()} 颅顶=${await crownLabel.count()} `
      + `长腿=${await legsLabel.count()} 瘦颈=${await neckLabel.count()} `
      + `双下巴=${await doubleChinLabel.count()} 直角肩=${await shoulderLabel.count()}`)
  const portraitRowBox = await portraitRow.boundingBox()
  check('人像第二行在 390px 不折行', !!portraitRowBox && portraitRowBox.height <= 64,
    `rowHeight=${portraitRowBox?.height ?? 0}`)
  await blemish.click()
  await page.waitForTimeout(250)
  check('去斑开关接得上且不撑破 390px 布局', await blemish.getAttribute('aria-pressed') === 'true'
    && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `pressed=${await blemish.getAttribute('aria-pressed')}`)
  await portraitRow.getByRole('button', { name: '取消' }).click()

  // ⑤b 磨皮画笔：工具行第二行要能完整放进 390px，且没涂过时主按钮不可按。
  await page.locator('.tool-row-main [aria-label="磨皮"]').click()
  const smoothRow = page.locator('.tool-row-second')
  await smoothRow.waitFor({ state: 'visible', timeout: 10_000 })
  const smoothStrength = smoothRow.locator('.slider-label', { hasText: '强度' })
  const smoothTexture = smoothRow.locator('.slider-label', { hasText: '纹理' })
  const smoothApply = smoothRow.getByRole('button', { name: '磨这里', exact: true })
  const smoothRowBox = await smoothRow.boundingBox()
  check('磨皮画笔第二行在 390px 可用且不折行', await smoothStrength.count() === 1
    && await smoothTexture.count() === 1 && await smoothApply.isDisabled()
    && !!smoothRowBox && smoothRowBox.height <= 64,
    `强度=${await smoothStrength.count()} 纹理=${await smoothTexture.count()} `
      + `disabled=${await smoothApply.isDisabled()} rowHeight=${smoothRowBox?.height ?? 0}`)
  await smoothRow.getByRole('button', { name: '取消' }).click()

  // ⑥ 局部：黑眼圈与自动眼下在 iPhone 宽度上真的存在、够得着。
  await page.locator('.tool-row-main [aria-label="局部"]').click()
  const localRow = page.locator('.tool-row-second')
  await localRow.waitFor({ state: 'visible', timeout: 15_000 })
  const darkCircle = localRow.getByRole('button', { name: '黑眼圈', exact: true })
  const autoUnderEye = localRow.getByRole('button', { name: '自动眼下', exact: true })
  await darkCircle.scrollIntoViewIfNeeded()
  await autoUnderEye.scrollIntoViewIfNeeded()
  check('局部黑眼圈 / 自动眼下控件可用', await darkCircle.count() === 1
    && await autoUnderEye.count() === 1 && await autoUnderEye.isEnabled(),
    `黑眼圈=${await darkCircle.count()} 自动眼下=${await autoUnderEye.count()}`)
  const contour = localRow.getByRole('button', { name: '修容', exact: true })
  const highlight = localRow.getByRole('button', { name: '高光', exact: true })
  await contour.scrollIntoViewIfNeeded()
  await contour.click()
  const contourShades = localRow.locator('[aria-label="修容色号"]')
  const contourReady = await contourShades.count() === 1
  await highlight.scrollIntoViewIfNeeded()
  await highlight.click()
  const highlightShades = localRow.locator('[aria-label="高光色号"]')
  check('局部修容 / 高光色板可用', await contour.count() === 1 && await highlight.count() === 1
    && contourReady && await highlightShades.count() === 1,
    `修容=${await contour.count()} 高光=${await highlight.count()} 色板=${contourReady}/${await highlightShades.count()}`)
  const aegyoSal = localRow.getByRole('button', { name: '卧蚕', exact: true })
  const eyeliner = localRow.getByRole('button', { name: '眼线', exact: true })
  await aegyoSal.scrollIntoViewIfNeeded()
  await aegyoSal.click()
  const aegyoSalShades = localRow.locator('[aria-label="卧蚕色号"]')
  const aegyoSalReady = await aegyoSalShades.count() === 1
  await eyeliner.scrollIntoViewIfNeeded()
  await eyeliner.click()
  const eyelinerShades = localRow.locator('[aria-label="眼线色号"]')
  check('局部卧蚕 / 眼线色板可用', await aegyoSal.count() === 1 && await eyeliner.count() === 1
    && aegyoSalReady && await eyelinerShades.count() === 1,
    `卧蚕=${await aegyoSal.count()} 眼线=${await eyeliner.count()} 色板=${aegyoSalReady}/${await eyelinerShades.count()}`)
  const iris = localRow.getByRole('button', { name: '美瞳', exact: true })
  await iris.scrollIntoViewIfNeeded()
  await iris.click()
  const irisShades = localRow.locator('[aria-label="美瞳色号"]')
  check('局部美瞳色板可用', await iris.count() === 1 && await irisShades.count() === 1,
    `美瞳=${await iris.count()} 色板=${await irisShades.count()}`)
  const dodge = localRow.getByRole('button', { name: '减淡', exact: true })
  const burn = localRow.getByRole('button', { name: '加深', exact: true })
  await dodge.scrollIntoViewIfNeeded()
  await dodge.click()
  const toneRange = localRow.locator('[aria-label="明暗范围"]')
  check('局部减淡 / 加深与三档明暗范围可用', await dodge.count() === 1
    && await burn.count() === 1 && await toneRange.count() === 1
    && await toneRange.getByRole('button', { name: '阴影', exact: true }).count() === 1
    && await toneRange.getByRole('button', { name: '中间调', exact: true }).count() === 1
    && await toneRange.getByRole('button', { name: '高光', exact: true }).count() === 1,
    `减淡=${await dodge.count()} 加深=${await burn.count()} 范围=${await toneRange.count()}`)
  check('局部控件不撑破 390px 布局',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)
  await localRow.getByRole('button', { name: '取消' }).click()

  // ⑦ 九宫格切图：作品页入口能打开，空工作区不横向溢出。
  await page.goto(`${BASE}/app/works`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '九宫格', exact: true }).click()
  await page.waitForSelector('.grid-split-page', { timeout: 15_000 })
  const gridDownload = page.locator('.grid-split-page .batch-run-button')
  check('九宫格切图入口可用', await page.getByRole('heading', { name: '九宫格切图' }).count() === 1
    && await gridDownload.count() === 1 && await gridDownload.isDisabled(),
    `标题=${await page.getByRole('heading', { name: '九宫格切图' }).count()} 下载=${await gridDownload.count()}`)
  check('九宫格页 390px 不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)
  await page.locator('.batch-back').click()
  // 测试账号可能是空作品集：等作品页自己的搜索框，而不是某一张作品卡。
  await page.waitForSelector('.gallery-search', { timeout: 15_000 })

  // ⑧ 长图拼接：作品页入口能打开，空工作区不横向溢出。
  await page.getByRole('button', { name: '长图', exact: true }).click()
  await page.waitForSelector('.long-image-page', { timeout: 15_000 })
  const longDownload = page.locator('.long-image-page .batch-run-button')
  check('长图拼接入口可用', await page.getByRole('heading', { name: '长图拼接' }).count() === 1
    && await longDownload.count() === 1 && await longDownload.isDisabled(),
    `标题=${await page.getByRole('heading', { name: '长图拼接' }).count()} 下载=${await longDownload.count()}`)
  check('长图页 390px 不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)
  await page.locator('.batch-back').click()
  await page.waitForSelector('.gallery-search', { timeout: 15_000 })

  // ⑧½ 短片调色：入口能开、空工作区不溢出、导出按钮先按不动。
  await page.getByRole('button', { name: '短片调色', exact: true }).click()
  await page.waitForSelector('.video-page', { timeout: 15_000 })
  const videoRun = page.locator('.video-page .crop-done')
  check('短片调色入口可用', await page.getByRole('heading', { name: '短片调色' }).count() === 1
    && await videoRun.count() === 1 && await videoRun.isDisabled()
    && await page.locator('.video-page input[aria-label="选择要调色的短片"]').count() === 1
    && await page.locator('.video-page input[aria-label="选择背景音乐"]').count() === 1
    && await page.locator('.video-page [aria-label="成片画幅"] button').count() === 5
    && await page.locator('.video-page input[aria-label="磨皮"], .video-page input[aria-label="美白"], .video-page input[aria-label="红润"]').count() === 3
    && await page.locator('.video-page .batch-toggle input').count() === 1,
    `标题=${await page.getByRole('heading', { name: '短片调色' }).count()} 导出=${await videoRun.count()}`
    + ` 画幅=${await page.locator('.video-page [aria-label="成片画幅"] button').count()}`
    + ` 原声=${await page.locator('.video-page .batch-toggle input').count()}`)
  check('短片调色页 390px 不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)
  await page.locator('.batch-back').click()
  await page.waitForSelector('.gallery-search', { timeout: 15_000 })

  // ⑧¾ 照片电影：入口能开、空工作区不溢出、导出按钮先按不动。
  await page.getByRole('button', { name: '照片电影', exact: true }).click()
  await page.waitForSelector('.movie-page', { timeout: 15_000 })
  const movieRun = page.locator('.movie-page .crop-done')
  check('照片电影入口可用', await page.getByRole('heading', { name: '照片电影' }).count() === 1
    && await movieRun.count() === 1 && await movieRun.isDisabled()
    && await page.locator('.movie-page input[aria-label="选择要做成电影的照片"]').count() === 1
    && await page.locator('.movie-page [aria-label="镜头运动"] button').count() === 4
    && await page.locator('.movie-page [aria-label="转场"] button').count() === 2,
    `标题=${await page.getByRole('heading', { name: '照片电影' }).count()} 导出=${await movieRun.count()}`
    + ` 运动=${await page.locator('.movie-page [aria-label="镜头运动"] button').count()}`)
  check('照片电影页 390px 不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)
  await page.locator('.batch-back').click()
  await page.waitForSelector('.gallery-search', { timeout: 15_000 })

  // ⑨ 批量页：390px 下 Lut 选择入口可见，页面不被新增控件撑宽。
  const batchButton = page.getByRole('button', { name: '批量处理', exact: true })
  await batchButton.click()
  await page.waitForSelector('.batch-page', { timeout: 15_000 })
  const lutField = page.locator('label.batch-preset').filter({ hasText: 'Lut' }).first()
  check('批量页 Lut 入口可用', await lutField.count() === 1
    && await lutField.locator('select').count() === 1,
    `lutFields=${await lutField.count()}`)
  const batchAutoLens = page.locator('label.batch-toggle')
    .filter({ hasText: '按 EXIF 自动镜头校正' })
  check('批量页自动镜头校正入口可用', await batchAutoLens.count() === 1
    && !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `count=${await batchAutoLens.count()}`)
  const namingMode = page.locator('label.batch-preset')
    .filter({ hasText: /^命名/ }).locator('select').first()
  const namingValues = await namingMode.locator('option').evaluateAll(options =>
    options.map(option => option.getAttribute('value')))
  check('批量页支持拍摄日期命名', namingValues.includes('date'), namingValues.join(' / '))
  check('批量页 390px 不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `overflow=${await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)}`)

  // 批量 TIFF：真的跑一张、下载 ZIP、从条目里读 TIFF 头。
  const batchPng = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 24
    const g = c.getContext('2d')
    g.fillStyle = 'rgb(84, 140, 196)'
    g.fillRect(0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  })
  await page.locator('.batch-page input[type="file"]').first().setInputFiles({
    name: 'batch-tiff.png',
    mimeType: 'image/png',
    buffer: Buffer.from(batchPng.split(',')[1], 'base64'),
  })
  const batchExport = page.locator('.batch-page .export-settings summary')
  if (await batchExport.count() && !(await page.locator('.batch-page .export-settings')
    .evaluate(el => el.open))) {
    await batchExport.click()
  }
  await page.locator('.batch-page label.export-choice', { hasText: 'TIFF' }).click()
  await page.evaluate(() => {
    const details = document.querySelector('.batch-page .export-settings')
    if (details) details.open = false
  })
  await page.getByRole('button', { name: '开始处理', exact: true }).click()
  await Promise.race([
    page.locator('.batch-result').waitFor({ state: 'visible', timeout: 30_000 }),
    page.locator('.batch-error').waitFor({ state: 'visible', timeout: 30_000 }),
  ])
  const batchError = await page.locator('.batch-error').count()
    ? await page.locator('.batch-error').innerText()
    : ''
  const batchFailure = await page.locator('.batch-failures').count()
    ? await page.locator('.batch-failures').innerText()
    : ''
  if (batchError) {
    throw new Error(`批量 TIFF 处理失败：${batchError}${batchFailure ? `；${batchFailure}` : ''}`)
  }
  const batchZip = page.getByRole('button', { name: '下载 ZIP', exact: true })
  await batchZip.waitFor({ state: 'visible', timeout: 30_000 })
  const zipDownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await batchZip.click()
  const zipDownload = await zipDownloadPromise
  const zipPath = await zipDownload.path()
  const tiffEntry = zipPath ? zipTiffHeader(zipPath) : null
  check('批量 TIFF 真实生成 ZIP，条目是 .tif 且文件头正确',
    zipDownload.suggestedFilename().endsWith('.zip')
      && tiffEntry?.name.endsWith('.tif')
      && tiffEntry.header.join(',') === '73,73,42,0',
    `${zipDownload.suggestedFilename()} entry=${tiffEntry?.name ?? '（没有 .tif）'}`
      + ` header=${tiffEntry?.header.map(v => v.toString(16).padStart(2, '0')).join(' ') ?? '（空）'}`)

  const unexpectedErrors = errors.filter(text =>
    !text.includes('ApiError: 连不上服务器'))
  check('控制台 / 页面错误（忽略已降级的后台网络提示）', unexpectedErrors.length === 0,
    unexpectedErrors.length
      ? unexpectedErrors.slice(0, 3).join(' | ')
      : (errors.length ? `仅 ${errors.length} 条后台网络降级提示` : '无错误'))
  await page.screenshot({ path: '.superpowers/scratch/safari-check.png' })

  const bad = checks.filter(c => !c.ok)
  console.log(bad.length
    ? `\n❌ ${bad.length}/${checks.length} 条不过`
    : `\n✅ ${checks.length}/${checks.length} 条全过（WebKit / 390px）`)
  if (bad.length) process.exitCode = 1
} finally {
  await browser.close()
}
