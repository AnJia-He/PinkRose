#!/usr/bin/env node
/**
 * Apple Live Photo 配对探针（WebKit / 390px）。
 *
 * 用一张真实 JPG 模拟 `IMG_9001.JPG + IMG_9001.MOV`，确认：
 *   · 网页认出这是一对，而不是把 MOV 悄悄丢掉；
 *   · 选择卡在 iPhone 宽度放得下；
 *   · 「修照片」继续进入现有修图链路。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const BASE = process.env.LIVE_PHOTO_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}
const withMetadata = (bytes, text) => Buffer.concat([bytes, Buffer.from(text)])
const movieWithId = id => Buffer.from(
  `moov/meta/keys/com.apple.quicktime.content.identifier/ilst/data/${id}`,
)
const ID_ONE = '12345678-1234-5678-9abc-def012345678'
const ID_TWO = '87654321-4321-8765-cba9-fedcba987654'
const ID_THREE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

async function prepare(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', {
    state: 'attached', timeout: 15_000,
  })
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
}

let browser
try {
  browser = await webkit.launch()
} catch (error) {
  console.error('❌ 没有找到 WebKit。先跑 `npx playwright install webkit`，再起 `npm run dev`。')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors = []
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  // 会话恢复是异步的；先让它落地，再开“新的一张”，否则旧照片会在选择文件后
  // 重新挂回画布，探针看起来像配对失败。
  await page.waitForTimeout(1_500)
  const fresh = page.getByRole('button', { name: '新的一张', exact: true })
  if (await fresh.count() && await fresh.isVisible()) {
    await fresh.click()
    await page.waitForFunction(() => !document.querySelector('canvas.canvas'), null, {
      timeout: 4_000,
    }).catch(() => {})
    await page.waitForTimeout(400)
  }
  const input = page.locator('input[data-photo-picker]').first()
  await input.setInputFiles([
    {
      name: 'IMG_8991.JPG',
      mimeType: 'image/jpeg',
      buffer: withMetadata(readFileSync(PORTRAIT), `Apple MakerNote ${ID_ONE}`),
    },
    {
      name: 'IMG_8991.MOV',
      mimeType: 'video/quicktime',
      buffer: movieWithId(ID_ONE),
    },
    {
      name: 'IMG_8992.HEIC',
      mimeType: 'image/heic',
      buffer: withMetadata(readFileSync(PORTRAIT), `Apple MakerNote ${ID_TWO}`),
    },
    {
      name: 'IMG_8992.MOV',
      mimeType: 'video/quicktime',
      buffer: movieWithId(ID_THREE),
    },
  ])
  const multiOffer = page.locator('.live-photo-offer')
  await multiOffer.waitFor({ state: 'visible', timeout: 10_000 })
  check('多组实况照片全部被识别并列出',
    (await multiOffer.innerText()).includes('找到 2 组实况照片')
      && await multiOffer.locator('.live-photo-row').count() === 2
      && await multiOffer.getByRole('button', { name: '全部修照片', exact: true }).count() === 1,
    '2 组 + 全部修照片')
  check('多组实况照片可以逐组打开照片或动作',
    await multiOffer.getByRole('button', { name: '修照片 IMG_8991.JPG', exact: true }).count() === 1
      && await multiOffer.getByRole('button', { name: '调动作 IMG_8992.MOV', exact: true }).count() === 1,
    '逐组入口 2 个')
  await page.waitForFunction(() =>
    document.querySelector('.live-photo-proof.verified')
      && document.querySelector('.live-photo-proof.mismatch'), null, { timeout: 5_000 })
  check('同名文件会核对 Apple 实况标识',
    (await multiOffer.locator('.live-photo-proof.verified').count()) === 1
      && (await multiOffer.locator('.live-photo-proof.mismatch').count()) === 1,
    'ID 一致 1 组 / 不一致 1 组')
  check('多组实况照片选择卡不撑破 390px',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')
  await multiOffer.getByRole('button', { name: '不用了', exact: true }).click()

  await input.setInputFiles([
    {
      name: 'IMG_9001.JPG',
      mimeType: 'image/jpeg',
      buffer: readFileSync(PORTRAIT),
    },
    {
      name: 'IMG_9001.MOV',
      mimeType: 'video/quicktime',
      buffer: movieWithId(ID_ONE),
    },
  ])
  const offer = page.locator('.live-photo-offer')
  await offer.waitFor({ state: 'visible', timeout: 10_000 })
  check('同名照片 + MOV 被识别为实况照片',
    (await offer.innerText()).includes('找到实况照片')
      && (await offer.innerText()).includes('IMG_9001.MOV'),
    '找到实况照片')
  check('照片 / 动作 / 取消三个选择都在',
    await offer.getByRole('button', { name: '修照片', exact: true }).count() === 1
      && await offer.getByRole('button', { name: '调动作', exact: true }).count() === 1
      && await offer.getByRole('button', { name: '不用了', exact: true }).count() === 1,
    '3 个选择')
  await page.waitForFunction(() =>
    document.querySelector('.live-photo-proof.unverified'), null, { timeout: 5_000 })
  check('没有实况标识时明确标成仅同名配对',
    (await offer.innerText()).includes('静帧里没有找到可核对的实况标识'),
    '仅同名配对')
  check('实况照片选择卡不撑破 390px',
    !(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')
  await offer.getByRole('button', { name: '修照片', exact: true }).click()
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas.canvas')
    return canvas instanceof HTMLCanvasElement && canvas.width > 0
  }, null, { timeout: 20_000 })
  check('修照片进入现有编辑器', await page.locator('canvas.canvas').count() === 1
    && await offer.count() === 0, 'canvas=1 offer=0')

  // 未核对的一组不提供兼容包导出；换到 ID 一致的一组再走真实下载。
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.locator('.export-settings > summary').click()
  const liveSection = page.locator('.export-live-photo')
  await liveSection.waitFor({ state: 'visible', timeout: 10_000 })
  check('未核对的实况照片不允许打包',
    await liveSection.getByRole('button', { name: '导出照片 + 动作 ZIP', exact: true }).isDisabled(),
    'disabled=true')

  // 新开一页走兼容包导出，避免上一个编辑器还在落盘时互相抢状态。
  const exportPage = await context.newPage()
  exportPage.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  exportPage.on('pageerror', error => errors.push(error.message))
  await prepare(exportPage)
  await exportPage.waitForTimeout(1_500)
  const exportFresh = exportPage.getByRole('button', { name: '新的一张', exact: true })
  if (await exportFresh.count() && await exportFresh.isVisible()) {
    await exportFresh.click()
    await exportPage.waitForFunction(() => !document.querySelector('canvas.canvas'), null, {
      timeout: 5_000,
    }).catch(() => {})
    await exportPage.waitForTimeout(400)
  }
  const exportInput = exportPage.locator('input[data-photo-picker]').first()
  await exportInput.setInputFiles([
    {
      name: 'IMG_9002.JPG',
      mimeType: 'image/jpeg',
      buffer: withMetadata(readFileSync(PORTRAIT), `Apple MakerNote ${ID_TWO}`),
    },
    {
      name: 'IMG_9002.MOV',
      mimeType: 'video/quicktime',
      buffer: movieWithId(ID_TWO),
    },
  ])
  const exportOffer = exportPage.locator('.live-photo-offer')
  await exportOffer.waitFor({ state: 'visible', timeout: 10_000 })
  await exportOffer.getByRole('button', { name: '修照片', exact: true }).click()
  await exportPage.waitForSelector('canvas.canvas', { timeout: 20_000 })
  await exportPage.locator('.nav-item', { hasText: '调色' }).first().click()
  await exportPage.locator('.export-settings > summary').click()
  const exportLiveSection = exportPage.locator('.export-live-photo')
  await exportLiveSection.waitFor({ state: 'visible', timeout: 10_000 })
  await exportLiveSection.locator('.live-photo-proof.verified').waitFor({
    state: 'visible', timeout: 10_000,
  })
  const liveButton = exportLiveSection.getByRole('button', {
    name: '导出照片 + 动作 ZIP', exact: true,
  })
  check('ID 一致的实况照片可以导出兼容包',
    await liveButton.isEnabled(), 'enabled=true')
  const [download] = await Promise.all([
    exportPage.waitForEvent('download', { timeout: 30_000 }),
    liveButton.click(),
  ])
  const path = await download.path()
  if (!path) throw new Error('实况照片兼容包没有下载路径')
  const bundleText = readFileSync(path).toString('latin1')
  check('兼容包文件名明确不是原生 Live Photo',
    download.suggestedFilename().includes('实况照片兼容包')
      && download.suggestedFilename().endsWith('.zip'),
    download.suggestedFilename())
  check('ZIP 里是同一 stem 的 JPG + MOV',
    bundleText.includes('IMG_9002_pinkrose.jpg')
      && bundleText.includes('IMG_9002_pinkrose.MOV')
      && bundleText.includes(ID_TWO),
    'JPG + MOV + 原动作 ID')

  check('控制台 / 页面错误', errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' | ') : '无错误')
  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 实况照片探针失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  await browser.close()
}
