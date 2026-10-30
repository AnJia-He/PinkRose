#!/usr/bin/env node
/**
 * iPad / tablet layout probe (WebKit).
 *
 * The desktop three-column layout (nav + preset rail + panel) leaves only a
 * sliver for the photo on a 768px portrait iPad. This probe opens the adjust
 * screen at the common iPad sizes and checks that the photo, preset strip,
 * panel, and the smoothing tool's primary button all remain usable.
 *
 * Usage:
 *   npm run dev
 *   npm run check:tablet
 */
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.SAFARI_BASE ?? 'http://localhost:5173'
const APP = `${BASE}/app`
const PHOTO = fileURLToPath(new URL('../test-photos/e2e_first_use.jpg', import.meta.url))
const SHOTS = fileURLToPath(new URL('../.superpowers/shots', import.meta.url))
const SMOOTH = '\u78e8\u76ae'
const VIEWS = [
  { slug: 'ipad-768x1024', width: 768, height: 1024 },
  { slug: 'ipad-834x1194', width: 834, height: 1194 },
  { slug: 'ipad-1024x768', width: 1024, height: 768 },
  { slug: 'ipad-1194x834', width: 1194, height: 834 },
  { slug: 'ipad-900x600', width: 900, height: 600 },
]

const checks = []
const check = (name, ok, got) => {
  checks.push({ name, ok, got })
  console.log(`${ok ? 'OK' : 'FAIL'} ${name} -- ${got}`)
}

async function loginIfNeeded(page) {
  await page.waitForSelector('.login-box, input[type="file"]', {
    state: 'attached', timeout: 15_000,
  })
  if (!(await page.locator('.login-box').count())) return
  await page.locator('.login-box').waitFor({ state: 'visible', timeout: 15_000 })
  const status = await page.evaluate(async ({ name, password, email }) => {
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
  }, { name: 'safaricheck', password: 'safari-check-only', email: 'safaricheck@example.com' })
  if (status !== 'login' && status !== 200) throw new Error(`login/signup failed: HTTP ${status}`)
  await page.reload({ waitUntil: 'load' })
}

async function openFresh(page) {
  // 固定账号会带着上一次探针恢复出来的会话。先等恢复真正落地：
  // networkidle 只代表网络停了，逐张解码头像 / 生成缩略图还要一会儿；
  // 这期间「新的一张」已经可见，点它会正常地作废恢复并留下一条 console.error。
  // 恢复期间 `busy` 会把上传器整个藏起来，所以「有上传框且没画布」不会提前成立。
  await page.waitForLoadState('networkidle').catch(() => {})
  await Promise.race([
    page.locator('.notice').filter({ hasText: '这是上次没做完的那张' })
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    page.waitForFunction(() => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'), null, { timeout: 20_000 }).catch(() => {}),
  ])
  // 恢复上一次会话时，file input 会先挂上、随后被画布替换。这里不能
  // 只等一次就 setInputFiles：输入框可能在等待期间被恢复出来的画布换掉。
  // 用一个短循环，每次只做一件事：有画布就点「新的一张」；输入框稳定
  // 五秒还活着才上传；被换掉就回到循环继续等。
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await page.locator('canvas.canvas').count()) {
      const fresh = page.locator('.actions button').nth(2)
      if (await fresh.count() && await fresh.isEnabled()) {
        await fresh.click()
        await page.waitForTimeout(800)
      }
    }
    if (await page.locator('input[type="file"]').count()) {
      await page.waitForTimeout(500)
      if (!(await page.locator('canvas.canvas').count())
        && await page.locator('input[type="file"]').count()) {
        try {
          await page.setInputFiles('input[type="file"]', PHOTO, { timeout: 5_000 })
          await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
          // 这一步真的传上了吗？恢复出来的画布也可能在等待期间落地。
          // 测试照片是 1200×800；不是它就回循环，别拿旧会话量版面。
          const natural = await page.evaluate(() => {
            const c = document.querySelector('canvas.canvas')
            return c ? [c.width, c.height] : null
          })
          if (!natural || natural[0] !== 1200 || natural[1] !== 800) continue
          await page.waitForTimeout(900)
          await page.locator('.nav-item').nth(1).click()
          await page.waitForSelector('.panel', { timeout: 10_000 })
          await page.waitForTimeout(700)
          return
        } catch {
          // 会话恢复恰好在这一下把输入框换成了画布 —— 回循环，点新的一张。
        }
      }
    }
    await page.waitForTimeout(300)
  }
  throw new Error('openFresh: 30 秒内没走到可上传的那一屏')
}

let browser
try {
  browser = await webkit.launch()
} catch (e) {
  console.error('WebKit is missing. Run `npx playwright install webkit` first.')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

mkdirSync(SHOTS, { recursive: true })
const page = await browser.newPage({
  viewport: { width: VIEWS[0].width, height: VIEWS[0].height },
  deviceScaleFactor: 2,
  hasTouch: true,
})
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

try {
  await page.goto(APP, { waitUntil: 'load' })
  await loginIfNeeded(page)

  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: view.height })
    await page.goto(APP, { waitUntil: 'load' })
    await loginIfNeeded(page)
    errors.length = 0
    await openFresh(page)
    // openFresh 为了拿到干净的上传屏，可能会在上一次会话恢复 / 落盘
    // 还没收尾时点「新的一张」；那种主动打断会产生一条作废日志。
    // 探针要抓的是**布局交互阶段**的页面错误，从这里开始重新收集。
    errors.length = 0

    const geo = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
        }
      }
      return {
        vw: innerWidth,
        vh: innerHeight,
        docW: document.documentElement.scrollWidth,
        canvas: box('canvas.canvas'),
        panel: box('.panel'),
        rail: box('.rail'),
        tool: box('.tool-row-main'),
        railScroll: document.querySelector('.rail')?.scrollWidth ?? null,
      }
    })

    check(`${view.slug} photo is usable`, !!geo.canvas
      && geo.canvas.w >= 360 && geo.canvas.h >= 240,
      geo.canvas ? `${geo.canvas.w}x${geo.canvas.h}` : 'missing canvas')
    check(`${view.slug} no page overflow`, geo.docW <= geo.vw + 1,
      `${geo.docW}/${geo.vw}`)
    check(`${view.slug} panel is visible`, !!geo.panel
      && geo.panel.x >= 0 && geo.panel.right <= geo.vw + 1 && geo.panel.h >= 180,
      geo.panel ? `${geo.panel.w}x${geo.panel.h} @${geo.panel.x},${geo.panel.y}` : 'missing panel')
    check(`${view.slug} preset strip is visible`, !!geo.rail
      && geo.rail.w > 0 && geo.rail.h >= 80,
      geo.rail ? `${geo.rail.w}x${geo.rail.h} scroll=${geo.railScroll}` : 'missing rail')
    check(`${view.slug} tool row stays inside viewport`, !!geo.tool
      && geo.tool.right <= geo.vw + 1,
      geo.tool ? `${geo.tool.w} @${geo.tool.x}` : 'missing tool row')

    await page.locator(`.tool-row-main [aria-label="${SMOOTH}"]`).click()
    await page.waitForSelector('.tool-row-second', { timeout: 10_000 })
    const tool = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
        }
      }
      const row = document.querySelector('.tool-row-second')
      return {
        row: box('.tool-row-second'),
        done: box('.tool-row-second .crop-done'),
        scrollW: row?.scrollWidth ?? null,
        clientW: row?.clientWidth ?? null,
        vw: innerWidth,
      }
    })
    check(`${view.slug} smoothing primary action is reachable`, !!tool.done
      && tool.done.w > 0 && tool.done.right <= tool.vw + 1,
      tool.done ? `${tool.done.w}x${tool.done.h} right=${tool.done.right}/${tool.vw}` : 'missing done')
    check(`${view.slug} tool controls keep one row`, !!tool.row
      // WebKit 给横向滚动条留 16px；49 的内容 + 16 = 65。
      // 真折成两行会是 98px 上下，所以 66 仍然能抓住折行。
      && tool.row.h <= 66,
      tool.row ? `${tool.row.h}px high, scroll=${tool.scrollW}/${tool.clientW}` : 'missing row')

    await page.locator('.tool-row-main [aria-label="点修"]').click()
    await page.waitForSelector('.tool-row-second', { timeout: 10_000 })
    await page.getByRole('button', { name: 'AI 消除', exact: true }).first().click()
    await page.waitForSelector('.crop-done', { timeout: 10_000 })
    const ai = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
        }
      }
      const row = document.querySelector('.tool-row-second')
      return {
        row: box('.tool-row-second'),
        done: box('.tool-row-second .crop-done'),
        scrollW: row?.scrollWidth ?? null,
        clientW: row?.clientWidth ?? null,
        vw: innerWidth,
      }
    })
    check(`${view.slug} AI erase primary action is reachable`, !!ai.done
      && ai.done.w > 0 && ai.done.right <= ai.vw + 1,
      ai.done ? `${ai.done.w}x${ai.done.h} right=${ai.done.right}/${ai.vw}` : 'missing done')
    check(`${view.slug} AI erase controls keep one row`, !!ai.row
      && ai.row.h <= 66,
      ai.row ? `${ai.row.h}px high, scroll=${ai.scrollW}/${ai.clientW}` : 'missing row')

    // 黑眼圈 / 自动眼下：本地人像修补的新入口，在 iPad 上也要够得着。
    await page.locator('.tool-row-main [aria-label="局部"]').click()
    await page.waitForSelector('.tool-row-second', { timeout: 10_000 })
    const local = await page.evaluate(() => {
      const row = document.querySelector('.tool-row-second')
      const buttons = [...(row?.querySelectorAll('button') ?? [])]
        .map(b => (b.textContent ?? '').trim())
      const r = row?.getBoundingClientRect()
      return {
        h: r ? Math.round(r.height) : null,
        hasDarkCircle: buttons.includes('黑眼圈'),
        hasAutoUnderEye: buttons.includes('自动眼下'),
        hasDodge: buttons.includes('减淡'),
        hasBurn: buttons.includes('加深'),
      }
    })
    check(`${view.slug} dark-circle controls are reachable`,
      local.hasDarkCircle && local.hasAutoUnderEye,
      `黑眼圈=${local.hasDarkCircle} 自动眼下=${local.hasAutoUnderEye}`)
    check(`${view.slug} dodge and burn controls are reachable`,
      local.hasDodge && local.hasBurn,
      `减淡=${local.hasDodge} 加深=${local.hasBurn}`)
    const dodge = page.locator('.tool-row-second').getByRole('button', { name: '减淡', exact: true })
    await dodge.scrollIntoViewIfNeeded()
    await dodge.click()
    await page.waitForTimeout(100)
    const range = page.locator('.tool-row-second [aria-label="明暗范围"]')
    const rangeState = await range.evaluate((el) => {
      const rowEl = el.closest('.tool-row-second')
      const scrollEl = el.closest('.local-scroll') ?? rowEl
      const row = el.closest('.tool-row-second')?.getBoundingClientRect()
      const actions = el.closest('.tool-row-second')?.querySelector('.crop-tools')
        ?.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      if (!rowEl || !row || !actions) return { visible: false }
      const center = box.left + box.width / 2
      return {
        visible: center >= row.left && center <= Math.min(row.right, actions.left),
        row: [Math.round(row.left), Math.round(row.right)],
        range: [Math.round(box.left), Math.round(box.right)],
        actions: [Math.round(actions.left), Math.round(actions.right)],
        scroll: [Math.round(scrollEl.scrollLeft), scrollEl.clientWidth, scrollEl.scrollWidth],
      }
    })
    const rangeVisible = rangeState.visible
    check(`${view.slug} dodge / burn range controls are reachable`,
      await range.count() === 1
        && await range.getByRole('button', { name: '阴影', exact: true }).count() === 1
        && await range.getByRole('button', { name: '中间调', exact: true }).count() === 1
        && await range.getByRole('button', { name: '高光', exact: true }).count() === 1,
      `range=${await range.count()}`)
    check(`${view.slug} dodge / burn range is visible after selection`, rangeVisible,
        `visible=${rangeVisible} state=${JSON.stringify(rangeState)}`)
    check(`${view.slug} local controls keep one row`, local.h !== null && local.h <= 66,
      local.h !== null ? `${local.h}px high` : 'missing row')
    check(`${view.slug} no console errors`, errors.length === 0,
      errors.length ? errors.join(' | ').slice(0, 300) : 'none')

    await page.screenshot({ path: join(SHOTS, `tablet-${view.slug}.png`) })
  }

  const bad = checks.filter(c => !c.ok)
  console.log(bad.length
    ? `\nFAIL ${bad.length}/${checks.length} tablet checks`
    : `\nOK ${checks.length}/${checks.length} tablet checks (WebKit)`)
  if (bad.length) process.exitCode = 1
} finally {
  await browser.close()
}
