#!/usr/bin/env node
/**
 * HEIC / RAW / TIFF 上传兜底探针（Chromium）。
 *
 * Windows 等没有本机转换器的机器：上传一个无法解码的 HEIC，确认浏览器确实
 * 请求 `/api/import/convert`，并在失败后给出人话。
 * macOS：先用系统 sips 把测试 JPG 转成真实 HEIC，再确认它经服务端转换后
 * 能进入编辑器。Chromium 不原生支持 HEIC，正好能走兜底路径。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.IMPORT_BASE ?? 'http://localhost:5173'
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
}

async function uploadSample(page, sample) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = page.getByRole('button', { name: '新的一张', exact: true })
    if (await fresh.count() && await fresh.isVisible()) {
      await fresh.click({ timeout: 2_000 }).catch(() => {})
      await page.waitForFunction(() => !document.querySelector('canvas.canvas'), null, {
        timeout: 3_000,
      }).catch(() => {})
    }
    if (await page.locator('input[type="file"]').count()
      && !(await page.locator('canvas.canvas').count())) {
      try {
        await page.locator('input[type="file"]').first()
          .setInputFiles(sample, { timeout: 5_000 })
        return
      } catch {
        // 会话恢复可能刚好换掉上传框，回到循环重开一张。
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error('30 秒内没有把测试 HEIC 交给上传框')
}

let tempDir = ''
let sample = ''
let expectSuccess = false
try {
  if (process.platform === 'darwin') {
    tempDir = mkdtempSync(join(tmpdir(), 'pinkrose-import-check-'))
    sample = join(tempDir, 'IMG_9001.HEIC')
    execFileSync('sips', ['-s', 'format', 'heic', PORTRAIT, '--out', sample], {
      stdio: 'ignore',
      timeout: 30_000,
    })
    expectSuccess = true
  } else {
    // 真实 HEIC 生成器在当前平台不存在；用一段坏数据验证失败路径与路由接线。
    const { writeFileSync } = await import('node:fs')
    tempDir = mkdtempSync(join(tmpdir(), 'pinkrose-import-check-'))
    sample = join(tempDir, 'IMG_9001.HEIC')
    writeFileSync(sample, new Uint8Array([0, 1, 2, 3, 4]))
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  try {
    await prepare(page)
    errors.length = 0
    let conversionStatus = 0
    page.on('response', response => {
      if (response.url().includes('/api/import/convert')) conversionStatus = response.status()
    })
    await uploadSample(page, sample)

    if (expectSuccess) {
      await page.waitForSelector('canvas.canvas', { timeout: 30_000 })
      check('真实 HEIC 经本机转换后进入编辑器', conversionStatus === 200,
        `status=${conversionStatus}`)
    } else {
      await page.waitForFunction(() => {
        const text = document.body.textContent ?? ''
        return text.includes('HEIC 打不开') || text.includes('打不开这张照片')
      }, null, { timeout: 30_000 })
      check('HEIC 解码失败会请求服务端兜底', conversionStatus > 0,
        `status=${conversionStatus}`)
      check('没有转换器时仍给出可执行的下一步',
        (await page.locator('body').innerText()).match(/Safari|JPG/g) !== null,
        '包含 Safari / JPG 提示')
    }
    check('390px 不横向溢出',
      !(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth)),
      'overflow=false')
    // 失败路径本来就会由 App 留一条解码诊断；这里只挡“预期的 503 / 解码失败”，
    // 其它控制台错误仍然算产品故障。
    const unexpected = errors.filter(message =>
      !message.includes('status of 503')
      && !message.includes('这张图片的解码器打不开它'))
    check('没有预期之外的控制台错误', unexpected.length === 0,
      unexpected.length ? unexpected.slice(0, 2).join(' | ') : '只有预期内的解码诊断')
    const failed = checks.filter(item => !item.ok)
    console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
    if (failed.length) process.exitCode = 1
  } finally {
    await browser.close()
  }
} catch (error) {
  console.error('❌ 导入兜底探针失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}
