#!/usr/bin/env node
/**
 * 镜头配置文件验收（WebKit / 1000px + 390px）。
 *
 * 用一张写了 Sony EXIF 的 JPEG 走真实浏览器：
 *   ① 调色面板「镜头校正」组里认出镜头；
 *   ② 点「套用配置」后三根校正滑杆真的变成配置值；
 *   ③ 画面真的变了；
 *   ④ 认不出时还能手动选一支；
 *   ⑤ 390px 下配置块不撑破布局。
 *
 * 先起开发服务器，再跑：
 *   npm run check:lens
 */
import { webkit } from 'playwright'
import piexif from 'piexifjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.LENS_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const TEST_JPEG = join(tmpdir(), 'lens-profile-check.jpg')
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

function makeTestJpeg() {
  const dataUrl = `data:image/jpeg;base64,${readFileSync(PORTRAIT).toString('base64')}`
  const exif = piexif.load(dataUrl)
  exif['0th'][piexif.ImageIFD.Make] = 'SONY'
  exif['0th'][piexif.ImageIFD.Model] = 'ILCE-7RM5'
  exif.Exif[piexif.ExifIFD.LensModel] = 'FE 85mm F1.8'
  exif.Exif[piexif.ExifIFD.FocalLength] = [85, 1]
  exif.Exif[piexif.ExifIFD.FocalLengthIn35mmFilm] = 85
  const out = piexif.insert(piexif.dump(exif), dataUrl)
  writeFileSync(TEST_JPEG, Buffer.from(out.split(',')[1], 'base64'))
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
  // 固定账号会积累上一轮的会话；不先清掉，自动恢复会和上传抢画布。
  // ⚠️ 必须放在登录分支**外面**：cookie 还在时 `.login-box` 不出现，
  // 放在里面就一次都不会清。
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
    } catch { /* 没登录 / 离线：后面按正常路径等上传框 */ }
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForLoadState('networkidle')
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 20_000 }).catch(() => {}),
  ])
}

async function uploadTest(page) {
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
          .setInputFiles(TEST_JPEG, { timeout: 5_000 })
        await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
        await page.waitForTimeout(800)
        return
      } catch { /* 会话恢复刚好换掉了上传框，重试 */ }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('30 秒内没把带 EXIF 的测试图传上去')
}

/** 会话自动恢复可能在我们上传之后才落地；以面板里的真实文件名确认这一张。 */
async function openAdjustForTest(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('.nav-item', { hasText: '调色' }).first().click()
    await page.waitForSelector('.lens-profile', { timeout: 10_000 })
    await page.waitForTimeout(350)
    const box = page.locator('.lens-profile')
    const name = await box.getAttribute('data-file')
    const status = await box.getAttribute('data-status')
    console.log(`   上传确认 ${attempt + 1}/3：file=${name} status=${status}`)
    if (name === 'lens-profile-check.jpg' && status === 'exif') return
    const home = page.locator('.nav-item', { hasText: '修图' }).first()
    if (await home.count()) await home.click()
    await page.waitForTimeout(300)
    await uploadTest(page)
  }
  throw new Error('没把带 EXIF 的测试图稳定传上去（会话恢复抢先了）')
}

async function sliderValue(page, label) {
  return page.locator('.panel label.slider')
    .filter({ has: page.locator('.slider-label', { hasText: label }) })
    .locator('.slider-value').innerText()
}

async function meanAbsDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const normalize = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const size = 200
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d')
      const k = Math.min(size / bmp.width, size / bmp.height)
      g.fillStyle = '#000'
      g.fillRect(0, 0, size, size)
      g.drawImage(bmp, (size - bmp.width * k) / 2, (size - bmp.height * k) / 2,
        bmp.width * k, bmp.height * k)
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

makeTestJpeg()
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

try {
  await prepare(page)
  errors.length = 0
  await uploadTest(page)
  await openAdjustForTest(page)
  await page.waitForTimeout(600)

  const box = page.locator('.lens-profile')
  const debug = await box.evaluate(el => ({
    file: el.getAttribute('data-file'),
    status: el.getAttribute('data-status'),
  }))
  console.log('   读取状态：', JSON.stringify(debug))
  const text = await box.innerText()
  check('EXIF 认出 Sony 镜头', text.includes('已识别') && text.includes('Sony FE 85mm F1.8'),
    text.replace(/\s+/g, ' ').trim())
  const select = box.locator('select')
  check('下拉自动选中对应配置', await select.inputValue() === 'sony-fe-85-18',
    `value=${await select.inputValue()}`)

  const canvas = page.locator('canvas.canvas')
  const before = await canvas.screenshot()
  const applyButton = box.getByRole('button', { name: '套用配置', exact: true })
  const canApply = await applyButton.isEnabled()
  if (canApply) {
    await applyButton.click()
    await page.waitForTimeout(600)
  }
  const values = {
    distortion: (await sliderValue(page, '畸变校正')).trim(),
    vignette: (await sliderValue(page, '暗角校正')).trim(),
    chromatic: (await sliderValue(page, '色差校正')).trim(),
  }
  check('套用后三根校正滑杆变成配置值',
    canApply && values.distortion === '6' && values.vignette === '24' && values.chromatic === '5',
    `畸变=${values.distortion} 暗角=${values.vignette} 色差=${values.chromatic}`)
  const after = await canvas.screenshot()
  const diff = await meanAbsDiff(page, before, after)
  check('套用配置真的改变画面', canApply && diff > 0.05, `meanAbsDiff=${diff.toFixed(3)}`)
  check('按钮变成已套用', canApply && (await box.innerText()).includes('已套用'), '已套用')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const narrow = await box.boundingBox()
  check('390px 镜头配置块不撑破布局', !!narrow && narrow.width <= 390
    && !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    `width=${Math.round(narrow?.width ?? 0)} overflow=false`)

  await select.selectOption('canon-rf-50-18')
  check('手动选择后标题跟着换（不残留自动识别那条）',
    (await box.innerText()).includes('Canon RF 50mm F1.8 STM')
      && !(await box.innerText()).includes('Sony FE 85mm F1.8'),
    (await box.innerText()).split('\n').slice(0, 3).join(' / '))
  await box.getByRole('button', { name: '套用配置', exact: true }).click()
  await page.waitForTimeout(400)
  const manual = {
    distortion: (await sliderValue(page, '畸变校正')).trim(),
    vignette: (await sliderValue(page, '暗角校正')).trim(),
    chromatic: (await sliderValue(page, '色差校正')).trim(),
  }
  check('手动选另一支镜头也能套用',
    manual.distortion === '5' && manual.vignette === '26' && manual.chromatic === '4',
    `畸变=${manual.distortion} 暗角=${manual.vignette} 色差=${manual.chromatic}`)

  const nameInput = box.locator('input[aria-label="自定义镜头配置名称"]')
  await nameInput.fill('我的测试镜头')
  await box.getByRole('button', { name: '存为我的配置', exact: true }).click()
  await page.waitForTimeout(250)
  check('当前三根能存成「我的配置」', (await select.inputValue()).startsWith('custom-')
    && (await box.innerText()).includes('我的测试镜头'),
    `value=${await select.inputValue()}`)
  await box.getByRole('button', { name: '删除这条', exact: true }).click()
  await page.waitForTimeout(200)
  check('自定义配置能删掉', !(await box.innerText()).includes('我的测试镜头'),
    `value=${await select.inputValue()}`)
  check('控制台无错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  if (process.env.LENS_SHOT) {
    await page.locator('.panel').screenshot({ path: process.env.LENS_SHOT })
    console.log('   截图：', process.env.LENS_SHOT)
  }

  const failed = checks.filter(c => !c.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.error('❌ 镜头配置探针中途失败：', e instanceof Error ? e.message : e)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
