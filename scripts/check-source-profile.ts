#!/usr/bin/env node
/**
 * Apple 源色彩识别探针：在 WebKit 390px 里上传一张带 ICC 的 JPEG，
 * 确认进入编辑器时说明 Display P3 → sRGB，照片信息也显示同一份配置。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { createSrgbIccProfile, injectJpegIcc } from '../src/export/colorProfile.ts'

const BASE = process.env.SAFARI_BASE ?? 'http://localhost:5173'
const APP = `${BASE}/app`
const PHOTO = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const checks: { name: string; ok: boolean; got: string }[] = []
const check = (name: string, ok: boolean, got: string) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

function displayP3Jpeg(): Uint8Array {
  const profile = createSrgbIccProfile()
  const needle = Buffer.from('PinkRose sRGB')
  const replacement = Buffer.from('Display P3   ')
  const at = Buffer.from(profile).indexOf(needle)
  if (at < 0) throw new Error('测试 ICC 里找不到描述标签')
  profile.set(replacement, at)
  return profile
}

async function prepare(page) {
  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[data-photo-picker]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    const who = 'sourceprofilecheck'
    const password = 'source-profile-check-only'
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
const errors: string[] = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

try {
  await prepare(page)
  errors.length = 0
  const jpeg = readFileSync(PHOTO)
  const tagged = await injectJpegIcc(new Blob([jpeg], { type: 'image/jpeg' }), displayP3Jpeg())
  await page.locator('input[data-photo-picker]').setInputFiles({
    name: 'display-p3.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(await tagged.arrayBuffer()),
  })
  await page.waitForSelector('canvas.canvas', { timeout: 20_000 })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.bubble-text')]
      .some(el => el.textContent?.includes('源色彩是 Display P3')), null, { timeout: 10_000 })
  const message = (await page.locator('.bubble-text').allTextContents()).join('\n')
  check('WebKit 识别 Display P3 源照片',
    message.includes('源色彩是 Display P3')
      && message.includes('编辑和导出先统一转成 sRGB')
      && message.includes('不会伪装成广色域编辑'),
    message.split('\n').find(line => line.includes('Display P3')) ?? '没有提示')

  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.getByRole('button', { name: '照片信息', exact: true }).click()
  await page.waitForFunction(() => {
    const info = document.querySelector('.photo-info')
    return info?.textContent?.includes('色彩配置') && info.textContent.includes('Display P3')
  }, null, { timeout: 10_000 })
  check('照片信息显示源色彩配置', true, '色彩配置 = Display P3')
  check('390px 布局不横向溢出',
    !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    'overflow=false')
  check('控制台 / 页面错误', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(failed.length
    ? `\n❌ ${failed.length}/${checks.length} 条不过`
    : `\n✅ ${checks.length}/${checks.length} 条全过（WebKit / 源 ICC）`)
  if (failed.length) process.exitCode = 1
} finally {
  await browser.close()
}
