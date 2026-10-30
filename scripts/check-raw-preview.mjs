#!/usr/bin/env node
/**
 * RAW 内嵌 JPEG 预览探针。
 *
 * 起开发服务器后运行：
 *   npm run check:raw-preview
 *
 * 测试文件是一个带 TIFF/DNG 头、内部嵌入真实 JPEG 的最小容器，并以 Pentax
 * `.PEF` 文件名上传，顺带验证扩展 RAW 后缀不会被选片层提前拒绝。页面会先
 * 尝试浏览器解码和本机转换器；探针把转换器固定成不可用，再确认 WebKit
 * 能从 RAW 容器里找到相机预览、进入修图并明确说明这不是完整解档。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const BASE = process.env.SAFARI_BASE ?? 'http://localhost:5173'
const APP = `${BASE}/app`
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

function syntheticDng() {
  const jpeg = readFileSync(PORTRAIT)
  const make = Buffer.from('Sony\0')
  const model = Buffer.from('ILCE-7RM5\0')
  const lens = Buffer.from('FE 24-70mm F2.8 GM II\0')
  const ifd0 = 8
  const exifAt = ifd0 + 2 + 3 * 12 + 4
  const exifEntries = 3
  const dataAt = exifAt + 2 + exifEntries * 12 + 4
  const makeAt = dataAt
  const modelAt = makeAt + make.length
  const lensAt = modelAt + model.length
  const focalAt = lensAt + lens.length
  const jpegAt = (focalAt + 8 + 1) & ~1
  const bytes = Buffer.alloc(jpegAt + jpeg.length)
  bytes.write('II', 0, 'ascii')
  bytes.writeUInt16LE(42, 2)
  bytes.writeUInt32LE(ifd0, 4)
  const entry = (at, tag, type, count, value) => {
    bytes.writeUInt16LE(tag, at)
    bytes.writeUInt16LE(type, at + 2)
    bytes.writeUInt32LE(count, at + 4)
    if (type === 3 && count === 1) bytes.writeUInt16LE(value, at + 8)
    else bytes.writeUInt32LE(value, at + 8)
  }
  bytes.writeUInt16LE(3, ifd0)
  entry(ifd0 + 2, 271, 2, make.length, makeAt)
  entry(ifd0 + 14, 272, 2, model.length, modelAt)
  entry(ifd0 + 26, 34665, 4, 1, exifAt)
  bytes.writeUInt32LE(0, ifd0 + 38)
  bytes.writeUInt16LE(exifEntries, exifAt)
  entry(exifAt + 2, 42036, 2, lens.length, lensAt)
  entry(exifAt + 14, 37386, 5, 1, focalAt)
  entry(exifAt + 26, 41989, 3, 1, 50)
  bytes.writeUInt32LE(0, exifAt + 38)
  bytes.set(make, makeAt)
  bytes.set(model, modelAt)
  bytes.set(lens, lensAt)
  bytes.writeUInt32LE(50, focalAt)
  bytes.writeUInt32LE(1, focalAt + 4)
  bytes.set(jpeg, jpegAt)
  return bytes
}

async function prepare(page) {
  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    const who = 'rawpreviewcheck'
    const password = 'raw-preview-check-only'
    const status = await page.evaluate(async ({ name, email, password }) => {
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
    }, { name: who, email: `${who}@example.com`, password })
    if (status !== 200 && status !== 'login') throw new Error(`测试账号登录失败：${status}`)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('input[data-photo-picker]', { state: 'attached', timeout: 15_000 })
  }
}

const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
let convertCalls = 0
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/import/convert**', route => {
  convertCalls++
  return route.fulfill({
    // 模拟"转换器在，但这张 RAW 解不出来"：保留正常 HTTP 响应，
    // 避免浏览器把故意制造的 501 记成控制台错误。
    status: 200,
    contentType: 'image/jpeg',
    body: 'not a raw image',
  })
})

try {
  await prepare(page)
  errors.length = 0
  await page.locator('input[data-photo-picker]').setInputFiles({
    name: 'camera-preview.PEF',
    mimeType: 'image/x-pentax-pef',
    buffer: syntheticDng(),
  })
  await page.waitForSelector('canvas.canvas', { timeout: 20_000 })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.bubble-text')]
      .some(el => el.textContent?.includes('相机内嵌的 JPEG 预览')), null, { timeout: 10_000 })

  const result = await page.evaluate(() => ({
    texts: [...document.querySelectorAll('.bubble-text')].map(el => el.textContent ?? ''),
    canvas: (() => {
      const canvas = document.querySelector('canvas.canvas')
      return canvas ? { width: canvas.width, height: canvas.height } : null
    })(),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  const text = result.texts.join('\n')
  check('RAW 内嵌预览进入编辑器', !!result.canvas
    && result.canvas.width > 0 && result.canvas.height > 0,
    result.canvas ? `${result.canvas.width}×${result.canvas.height}` : '没有画布')
  check('没有 RAW 转换器时没有白传原文件', convertCalls === 0,
    `convertCalls=${convertCalls}`)
  check('明确说明不是完整 RAW 解档',
    text.includes('相机内嵌的 JPEG 预览')
      && !!result.canvas && text.includes(`${result.canvas.width}×${result.canvas.height}`)
      && text.includes('不是完整 RAW 解档'),
    text.split('\n').find(line => line.includes('RAW')) ?? '没有说明')
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.getByRole('button', { name: '照片信息', exact: true }).click()
  await page.waitForFunction(() => {
    const info = document.querySelector('.photo-info')
    return info?.textContent?.includes('Sony ILCE-7RM5')
      && info.textContent.includes('FE 24-70mm F2.8 GM II')
  }, null, { timeout: 10_000 })
  const photoInfo = await page.locator('.photo-info').innerText()
  check('RAW 元数据补全机型和镜头', photoInfo.includes('Sony ILCE-7RM5')
    && photoInfo.includes('FE 24-70mm F2.8 GM II') && photoInfo.includes('50 mm'),
    photoInfo.replace(/\s+/g, ' ').slice(0, 180))
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth)
  check('390px 布局不横向溢出', !overflow, `overflow=${overflow}`)
  check('控制台 / 页面错误', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(failed.length
    ? `\n❌ ${failed.length}/${checks.length} 条不过`
    : `\n✅ ${checks.length}/${checks.length} 条全过（WebKit / RAW 内嵌预览）`)
  if (failed.length) process.exitCode = 1
} finally {
  await browser.close()
}
