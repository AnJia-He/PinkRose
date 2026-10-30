#!/usr/bin/env node
/**
 * 连拍堆栈验收探针（WebKit）。
 *
 * 直接向测试账号创建 5 张相邻作品，验证收起、展开、整组多选和 390px 布局；
 * 结束后只删除本轮创建的 id，不碰账号里已有作品。
 */
import { webkit } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const BASE = process.env.BURST_BASE ?? 'http://localhost:5173'
const PORTRAIT = fileURLToPath(new URL('../test-photos/e2e_portrait.jpg', import.meta.url))
const image = `data:image/jpeg;base64,${readFileSync(PORTRAIT).toString('base64')}`
const dumpDir = process.env.BURST_DEBUG_DIR
const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function prepare(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (await page.locator('.login-box').count()) {
    const status = await page.evaluate(async () => {
      const name = 'safaricheck'
      const password = 'safari-check-only'
      const email = 'safaricheck@example.com'
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
    })
    if (status !== 200 && status !== 'login') {
      throw new Error(`测试账号登录/注册失败：HTTP ${status}`)
    }
    await page.reload({ waitUntil: 'load' })
  }
  // 直接落在作品页：测试账号可能留着旧的修图会话，恢复它会把无关的图片
  // 读取错误混进本探针。连拍堆栈不需要走修图页。
  await page.goto(`${BASE}/app/works`, { waitUntil: 'load' })
  await page.waitForSelector('.gallery', { timeout: 15_000 })
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

const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const errors = []
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', error => errors.push(error.message))

let ids = []
try {
  await prepare(page)
  // 登录后 App 仍会尝试接回测试账号的上一条会话；等这趟异步恢复彻底收尾，
  // 再开始统计本页控制台错误，避免旧会话的脏文件污染连拍验收。
  await page.waitForTimeout(2_500)
  errors.length = 0
  const capturedBase = Date.now() - 60 * 60_000
  ids = await page.evaluate(async ({ image: payload, capturedBase }) => {
    const made = await Promise.all(Array.from({ length: 5 }, (_, i) => (
      fetch('/api/works', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: payload,
          thumb: payload,
          sourceName: `IMG_${1000 + i}.JPG`,
          capturedAt: capturedBase + i * 300,
          cameraMake: 'SONY',
          cameraModel: 'ILCE-7CM2',
          lensModel: 'FE 50mm F1.4 GM',
        }),
      }).then(response => response.json())
    )))
    return made.map(item => item.id).filter(Boolean)
  }, { image, capturedBase })
  if (ids.length !== 5) throw new Error(`只创建了 ${ids.length} 张测试作品`)

  const savedMeta = await page.evaluate(async (wanted) => {
    const response = await fetch('/api/works', { credentials: 'same-origin' })
    const { works } = await response.json()
    return works.filter(work => wanted.includes(work.id))
  }, ids)
  check('作品接口保存原文件名和拍摄时间',
    savedMeta.length === 5
      && savedMeta.every(work => work.sourceName?.startsWith('IMG_'))
      && savedMeta.every(work => Number.isFinite(work.capturedAt)),
    `saved=${savedMeta.length}`)
  check('作品接口保存机身和镜头',
    savedMeta.every(work => work.cameraMake === 'SONY')
      && savedMeta.every(work => work.cameraModel === 'ILCE-7CM2')
      && savedMeta.every(work => work.lensModel === 'FE 50mm F1.4 GM'),
    `camera=${savedMeta[0]?.cameraModel ?? 'missing'}`)

  await page.goto(`${BASE}/app/works`, { waitUntil: 'load' })
  await page.waitForSelector('.gallery-stack', { timeout: 20_000 })

  const stack = page.locator('.gallery-stack').filter({ has: page.locator('.gallery-stack-count') }).first()
  const trigger = stack.locator('.gallery-stack-trigger')
  check('5 张相邻作品自动折成连拍组', await stack.count() === 1, `stack=${await stack.count()}`)
  check('收起时不铺开每一张',
    await stack.locator('.gallery-cell').count() === 0,
    `expandedCells=${await stack.locator('.gallery-cell').count()}`)

  const shotToggle = page.locator('button[aria-label="切换为按拍摄时间分组"]')
  check('有 EXIF 时可切换拍摄时间视图', await shotToggle.count() === 1, `toggle=${await shotToggle.count()}`)
  await shotToggle.click()
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.gallery-day-title')]
      .some(element => element.textContent?.includes('拍摄于'))
  ))
  check('日期标题明确标出拍摄分组',
    await page.locator('.gallery-day-title').first().textContent()
      .then(text => text?.includes('拍摄于') === true),
    await page.locator('.gallery-day-title').first().textContent())

  const search = page.locator('.gallery-search')
  await search.fill('ilce-7cm2')
  await page.waitForFunction(() => document.querySelectorAll('.gallery-stack').length === 1)
  check('作品页能按机身搜索',
    await page.locator('.gallery-stack').count() === 1,
    `stacks=${await page.locator('.gallery-stack').count()}`)
  await search.fill('')
  await page.waitForFunction(() => document.querySelectorAll('.gallery-stack').length === 1)

  const gear = page.locator('select[aria-label="按器材筛选"]')
  check('作品页提供机身 / 镜头筛选', await gear.count() === 1, `gear=${await gear.count()}`)
  await gear.selectOption('camera:SONY ILCE-7CM2')
  await page.waitForFunction(() => document.querySelectorAll('.gallery-stack').length === 1)
  check('按机身筛选只留下这台相机的作品',
    await page.locator('.gallery-stack').count() === 1,
    `stacks=${await page.locator('.gallery-stack').count()}`)
  await gear.selectOption('all')

  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true })
    await page.screenshot({
      path: join(dumpDir, 'bursts-desktop-collapsed.png'),
      fullPage: false,
    })
  }

  await trigger.click()
  await page.waitForFunction(() => (
    document.querySelector('.gallery-stack-trigger')?.getAttribute('aria-expanded') === 'true'
  ))
  const expanded = stack.locator('.gallery-stack-expanded .gallery-cell')
  check('展开后完整保留 5 张作品', await expanded.count() === 5, `cells=${await expanded.count()}`)
  check('展开态有无障碍状态', await trigger.getAttribute('aria-expanded') === 'true', 'aria-expanded=true')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  check('390px 连拍组不横向溢出',
    !(await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    ))),
    'overflow=false')

  if (dumpDir) {
    await page.screenshot({
      path: join(dumpDir, 'bursts-mobile-expanded.png'),
      fullPage: false,
    })
    await trigger.click()
    await page.waitForFunction(() => (
      document.querySelector('.gallery-stack-trigger')?.getAttribute('aria-expanded') === 'false'
    ))
    await page.screenshot({
      path: join(dumpDir, 'bursts-mobile-collapsed.png'),
      fullPage: false,
    })
    await trigger.click()
    await page.waitForFunction(() => (
      document.querySelector('.gallery-stack-trigger')?.getAttribute('aria-expanded') === 'true'
    ))
  }

  await stack.locator('.gallery-stack-select').click()
  const checked = page.locator('input[aria-label="选中这张作品"]:checked')
  check('整组多选选中真实 5 张作品', await checked.count() === 5, `checked=${await checked.count()}`)

  const review = page.locator('button[aria-label="智能复查选中"]')
  check('整组可智能复查', await review.isEnabled(), `enabled=${await review.isEnabled()}`)
  await review.click()
  await page.waitForFunction(() => (
    document.querySelector('.gallery-select-count')?.textContent?.includes('已复查 5 张')
  ), null, { timeout: 20_000 })
  check('智能复查给出保留 / 复查建议',
    (await page.locator('.gallery-select-count').textContent())?.includes('建议')
      === true,
    await page.locator('.gallery-select-count').textContent())

  await stack.locator('.gallery-stack-best').click()
  await page.waitForFunction(() => (
    document.querySelector('.gallery-select-count')?.textContent?.includes('这一组推荐')
  ), null, { timeout: 20_000 })
  check('整组挑最好只留下推荐张', await checked.count() === 1, `checked=${await checked.count()}`)
  check('推荐句包含本机评分',
    (await page.locator('.gallery-select-count').textContent())?.includes('本机评分') === true,
    await page.locator('.gallery-select-count').textContent())

  await page.locator('input[aria-label="选中这张作品"]:not(:checked)').first().check()
  const compare = page.locator('button[aria-label="对比选中的两张"]')
  check('选中两张后可进入对比', await compare.isEnabled(), `enabled=${await compare.isEnabled()}`)
  await compare.click()
  await page.waitForSelector('.cull-stage.comparing', { timeout: 15_000 })
  check('图库直达左右对比',
    await page.locator('.cull-compare-label').count() === 2,
    `labels=${await page.locator('.cull-compare-label').count()}`)
  await page.locator('.cull-close').click()
  await page.waitForSelector('.gallery-select', { timeout: 15_000 })

  await page.locator('.gallery-select-cancel').click()
  await expanded.first().click()
  await page.waitForSelector('.detail-source', { timeout: 15_000 })
  if (dumpDir) {
    await page.screenshot({
      path: join(dumpDir, 'work-detail-source-mobile.png'),
      fullPage: false,
    })
  }
  const sourceText = await page.locator('.detail-source').textContent()
  check('作品详情显示原文件、机身、镜头和拍摄时间',
    sourceText?.includes('IMG_') === true
      && sourceText?.includes('SONY ILCE-7CM2') === true
      && sourceText?.includes('FE 50mm F1.4 GM') === true
      && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(sourceText ?? ''),
    sourceText ?? 'missing')
  await page.locator('.detail-back').click()
  await page.waitForSelector('.gallery-stack', { timeout: 15_000 })

  check('浏览器控制台无错误', errors.length === 0, errors.length ? errors.slice(0, 2).join(' | ') : '无错误')

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
  if (failed.length) process.exitCode = 1
} catch (error) {
  console.error('❌ 连拍组探针中途失败：', error instanceof Error ? error.message : error)
  if (errors.length) console.error('控制台：', errors.slice(0, 3).join(' | '))
  process.exitCode = 1
} finally {
  if (ids.length) {
    await page.evaluate(async (toDelete) => {
      await fetch('/api/works/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: toDelete }),
      }).catch(() => {})
    }, ids).catch(() => {})
  }
  await browser.close()
}
