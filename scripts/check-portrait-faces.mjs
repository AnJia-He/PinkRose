#!/usr/bin/env node
/**
 * 合影单张修图验收（WebKit / 390px）。
 *
 * 单测证明“切脸后参数传给哪一张脸”；这条探针再走真实浏览器：
 *   ① 用两张正脸合成一张测试图，确认本地检测出现「选择人脸」；
 *   ② 切到「脸 2」，确认照片上的脸框位置真的换了；
 *   ③ 推开磨皮、应用，确认底图变化，且 390px 没有横向溢出、控制台无错。
 *
 * 先起开发服务器，再跑：npm run check:portrait
 */
import { webkit } from 'playwright'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const BASE = process.env.PORTRAIT_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

/**
 * 应用人像会换掉 `<canvas>` 节点；直接对 locator 截图会偶发撞上“旧节点已卸载”。
 * 用当前节点的屏幕盒子裁一张页面截图，既避开竞态，也仍然只比较照片区域。
 */
async function screenshotCanvas(page, canvas) {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('照片画布不在屏幕上')
  return page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  })
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
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 20_000 }).catch(() => {}),
  ])
}

async function makeTwoFacePhoto(page) {
  const dataUrl = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob()
    const source = await createImageBitmap(blob)
    const gap = Math.max(80, Math.round(source.width * 0.12))
    const canvas = document.createElement('canvas')
    canvas.width = source.width * 2 + gap
    canvas.height = source.height
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#252525'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(source, 0, 0)
    ctx.drawImage(source, source.width + gap, 0)
    source.close()
    return canvas.toDataURL('image/png')
  }, readFileSync(PORTRAIT).toString('base64'))
  const file = join(tmpdir(), `pinkrose-portrait-faces-${process.pid}.png`)
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'))
  return file
}

async function makeManualFacePhoto(page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 1200
    const ctx = canvas.getContext('2d')
    const image = ctx.createImageData(canvas.width, canvas.height)
    let seed = 20261021
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 80 + Math.round(random() * 60)
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = v
      image.data[i + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png')
  })
  const file = join(tmpdir(), `pinkrose-manual-face-${process.pid}.png`)
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'))
  return file
}

async function inspectDetectedFaces(page, b64) {
  return page.evaluate(async (encoded) => {
    const { detectFacesInBitmap } = await import('/src/image/faceDetect.ts')
    const blob = await (await fetch(`data:image/png;base64,${encoded}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const faces = await detectFacesInBitmap(bitmap, 6)
    bitmap.close()
    return faces
  }, b64)
}

async function uploadPhoto(page, file) {
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
          .setInputFiles(file, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(800)
        return
      } catch {
        // 会话恢复刚好换掉上传框；回到循环重开一张。
      }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('30 秒内没把双人测试图传上去')
}

async function meanAbsDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const size = 240
    const normalize = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const k = Math.min(size / bmp.width, size / bmp.height)
      const w = bmp.width * k
      const h = bmp.height * k
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, size, size)
      ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h)
      return ctx.getImageData(0, 0, size, size).data
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

const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))
let composite = ''
let manualPhoto = ''

try {
  await prepare(page)
  composite = await makeTwoFacePhoto(page)
  errors.length = 0
  await uploadPhoto(page, composite)
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.tool-row-main [aria-label="人像"]', { timeout: 10_000 })
  await page.locator('.tool-row-main [aria-label="人像"]').click()
  await page.waitForSelector('[aria-label="选择人脸"]', { timeout: 15_000 })

  const picker = page.locator('[aria-label="选择人脸"]')
  const chips = picker.getByRole('button')
  const faceCount = await chips.count()
  check('双人图识别出两张脸', faceCount === 3, `count=${faceCount}`)
  if (faceCount !== 3) {
    const boxes = await inspectDetectedFaces(
      page,
      readFileSync(composite).toString('base64'),
    )
    console.log('   检测框：', JSON.stringify(boxes))
  }

  const canvas = page.locator('canvas.canvas')
  const done = page.getByRole('button', { name: '应用人像', exact: true })
  const beforeSelect = await screenshotCanvas(page, canvas)
  const guide = page.locator('.face-guide')
  const firstBox = await guide.boundingBox()
  const slider = page.locator('.tool-row-second label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: '磨皮' }) })
  const range = slider.locator('input[type="range"]')
  await chips.nth(0).click()
  await page.waitForTimeout(300)
  check('「全部」同时标出两张脸', await page.locator('.face-guide').count() === 2,
    `guides=${await page.locator('.face-guide').count()}`)
  await range.focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find(el => el.textContent?.trim() === '应用人像')
    return button instanceof HTMLButtonElement && !button.disabled
  }, null, { timeout: 10_000 })
  await page.waitForTimeout(200)
  const allDiff = await meanAbsDiff(
    page, beforeSelect, await page.locator('canvas.canvas').screenshot(),
  )
  check('「全部」预览同时改变两张脸', allDiff > 0.1, `meanAbsDiff=${allDiff.toFixed(3)}`)
  await range.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(500)
  await page.locator('.face-guide').nth(1).click()
  await page.waitForTimeout(500)
  check('直接点照片里的脸框也能选中脸 2',
    await chips.nth(2).getAttribute('aria-pressed') === 'true',
    `pressed=${await chips.nth(2).getAttribute('aria-pressed')}`)
  const secondBox = await guide.boundingBox()
  check('切到脸 2 后照片上的脸框跟着换',
    Boolean(firstBox && secondBox && Math.abs(firstBox.x - secondBox.x) > 20),
    `face1.x=${firstBox?.x ?? '-'} face2.x=${secondBox?.x ?? '-'}`)
  check('选中的是脸 2',
    await chips.nth(2).getAttribute('aria-pressed') === 'true',
    `pressed=${await chips.nth(2).getAttribute('aria-pressed')}`)

  await range.focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('.tool-row-second label.slider')]
      .find(el => el.querySelector('.slider-label')?.textContent?.trim() === '磨皮')
    return label?.querySelector('.slider-value')?.textContent?.trim() === '100'
  }, null, { timeout: 8_000 })
  await page.waitForTimeout(700)
  const preview = await screenshotCanvas(page, canvas)
  const diff = await meanAbsDiff(page, beforeSelect, preview)
  check('脸 2 的磨皮预览真的改变画面', diff > 0.1, `meanAbsDiff=${diff.toFixed(3)}`)

  await done.scrollIntoViewIfNeeded()
  check('应用人像在 390px 可达', await done.isVisible() && await done.isEnabled(), 'visible + enabled')
  await done.click()
  await page.waitForSelector('.tool-row-second', { state: 'detached', timeout: 8_000 })
  await page.waitForTimeout(400)
  const applied = await meanAbsDiff(page, beforeSelect, await screenshotCanvas(page, canvas))
  check('应用后成片保留脸 2 的变化', applied > 0.1, `meanAbsDiff=${applied.toFixed(3)}`)

  manualPhoto = await makeManualFacePhoto(page)
  await uploadPhoto(page, manualPhoto)
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.locator('.tool-row-main [aria-label="人像"]').click()
  await page.waitForSelector('.face-pick', { timeout: 15_000 })
  const manualHint = (await page.locator('.face-pick-hint').textContent())?.trim() ?? ''
  check('自动找不到脸时留在手动圈脸模式',
    manualHint.includes('在照片上拖一个脸框') && manualHint.includes('按 Enter'),
    manualHint)

  const pickCanvas = await page.locator('canvas.canvas').boundingBox()
  if (!pickCanvas) throw new Error('手动圈脸时拿不到照片位置')
  const manualBefore = await page.locator('canvas.canvas').screenshot()
  await page.mouse.move(
    pickCanvas.x + pickCanvas.width * 0.28,
    pickCanvas.y + pickCanvas.height * 0.24,
  )
  await page.mouse.down()
  await page.mouse.move(
    pickCanvas.x + pickCanvas.width * 0.72,
    pickCanvas.y + pickCanvas.height * 0.62,
    { steps: 8 },
  )
  await page.mouse.up()
  await page.waitForSelector('.face-pick', { state: 'detached', timeout: 8_000 })
  check('手动拖框后回到人像参数',
    await page.getByRole('button', { name: '应用人像', exact: true }).isVisible(),
    `guides=${await page.locator('.face-guide').count()}`)

  const manualSlider = page.locator('.tool-row-second label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: '磨皮' }) })
  await manualSlider.locator('input[type="range"]').focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find(el => el.textContent?.trim() === '应用人像')
    return button instanceof HTMLButtonElement && !button.disabled
  }, null, { timeout: 10_000 })
  await page.getByRole('button', { name: '应用人像', exact: true }).click()
  await page.waitForSelector('.tool-row-second', { state: 'detached', timeout: 8_000 })
  await page.waitForTimeout(300)
  const manualDiff = await meanAbsDiff(
    page, manualBefore, await page.locator('canvas.canvas').screenshot(),
  )
  check('手动脸框确实进入人像处理', manualDiff > 0.1, `meanAbsDiff=${manualDiff.toFixed(3)}`)

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  check('合影选脸流程在 390px 不横向溢出', !overflow, String(overflow))
  check('控制台 / 页面无错误', errors.length === 0, errors.join(' | ') || '无错误')
} finally {
  await browser.close()
  if (composite) {
    try { unlinkSync(composite) } catch {}
  }
  if (manualPhoto) {
    try { unlinkSync(manualPhoto) } catch {}
  }
}

const failed = checks.filter(c => !c.ok)
console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过（WebKit / 390px）`)
if (failed.length) process.exit(1)
