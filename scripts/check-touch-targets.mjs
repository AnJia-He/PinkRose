#!/usr/bin/env node
/**
 * 苹果触控命中区验收（WebKit / iPhone + iPad）。
 *
 * 为什么单开一条：版面检查只量盒子在不在屏里，量不到「手指点上去会不会
 * 落到隔壁控件」；`@media (pointer: coarse)` 那层透明命中区又不会出现在
 * `getBoundingClientRect()` 里。这里用四向探针真的问浏览器：
 *   ① 每个当前可见的原生控件，中心点必须是自己；
 *   ② 中心上下左右各 21px 仍必须落到自己（即至少 44×44）；
 *   ③ 补命中区不能把照片行高撑坏，390px 照片仍至少 240×150。
 *
 * 只走登录、上传、调色和磨皮，不碰生成接口，不产生模型费用。
 */
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.env.TOUCH_BASE ?? 'http://localhost:5173'
const PHOTO = fileURLToPath(new URL('../test-photos/e2e_first_use.jpg', import.meta.url))
const checks = []

function check(name, ok, got) {
  checks.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function login(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (!await page.locator('.login-box').count()) return
  const status = await page.evaluate(async () => {
    const body = {
      username: 'touchcheck',
      password: 'touch-check-only',
      email: 'touchcheck@example.com',
    }
    let r = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.ok) return 'login'
    r = await fetch('/api/signup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.status
  })
  if (status !== 'login' && status !== 200 && status !== 409) {
    throw new Error(`触控验收账号登录失败：HTTP ${status}`)
  }
  await page.reload({ waitUntil: 'networkidle' })
}

async function freshPhoto(page) {
  const fresh = page.getByRole('button', { name: '新的一张', exact: true })
  if (await fresh.count() && await fresh.isVisible()) await fresh.click()
  await page.waitForFunction(
    () => !!document.querySelector('input[type="file"]')
      && !document.querySelector('canvas.canvas'),
    null,
    { timeout: 15_000 },
  )
  await page.locator('input[type="file"]').first().setInputFiles(PHOTO)
  await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
  await page.locator('.nav-item', { hasText: '调色' }).first().click()
  await page.waitForSelector('.panel', { timeout: 10_000 })
}

/**
 * 只检查“现在真的可见、且中心点能碰到”的控件。滚动容器外的项虽然仍在
 * DOM 里，但用户当下摸不到，不能拿它们制造假失败；滚进来以后同一套规则仍生效。
 */
async function scanVisibleTargets(
  page,
  selector = '.app button, .app summary, .app select, .app [role="button"], .app [role="slider"]',
) {
  return page.evaluate((selector) => {
    const targets = [...new Set(document.querySelectorAll(selector))].filter((el) => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < innerHeight
    })
    const failures = []
    let tested = 0
    for (const el of targets) {
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const owns = (x, y) => {
        const hit = document.elementFromPoint(x, y)
        return !!hit && (hit === el || el.contains(hit))
      }
      if (!owns(cx, cy)) continue
      tested++
      if (el.classList.contains('crop-h')) {
        const side = el.getAttribute('data-h') ?? ''
        const pseudo = getComputedStyle(el, '::after')
        const pseudoWidth = parseFloat(pseudo.width)
        const pseudoHeight = parseFloat(pseudo.height)
        const x = side.includes('w') ? rect.left + 22
          : side.includes('e') ? rect.right - 22
            : cx
        const y = side.includes('n') ? rect.top + 22
          : side.includes('s') ? rect.bottom - 22
            : cy
        if (pseudoWidth < 44 || pseudoHeight < 44 || !owns(x, y)) {
          failures.push(
            el.getAttribute('aria-label')
            || `裁剪把手 ${side}`,
          )
        }
        continue
      }
      const probes = [
        [cx, cy - 21], [cx, cy + 21], [cx - 21, cy], [cx + 21, cy],
      ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
      if (!probes.every(([x, y]) => owns(x, y))) {
        failures.push(
          el.getAttribute('aria-label')
          || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 32)
          || el.tagName,
        )
      }
    }
    return { tested, failures: [...new Set(failures)] }
  }, selector)
}

const browser = await webkit.launch()
try {
  for (const viewport of [
    { name: 'iPhone 390×844', width: 390, height: 844 },
    { name: 'iPad 768×1024', width: 768, height: 1024 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true,
      isMobile: true,
    })
    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    await login(page)
    errors.length = 0
    await freshPhoto(page)

    const panel = await scanVisibleTargets(page)
    check(
      `${viewport.name} · 调色面板每个可见控件有 44px 命中区`,
      panel.failures.length === 0,
      `tested=${panel.tested} failures=${JSON.stringify(panel.failures)}`,
    )
    const searchInput = page.getByRole('textbox', { name: '搜索调色参数' })
    await searchInput.fill('磨皮')
    await page.waitForFunction(() => {
      const titles = [...document.querySelectorAll('.panel-groups .panel-group-title')]
        .map(el => el.textContent)
      return titles.length === 1 && titles[0] === '效果'
    }, null, { timeout: 5_000 })
    const searchBox = await searchInput.boundingBox()
    check(
      `${viewport.name} · 参数搜索能定位「磨皮」且输入区高度足够`,
      searchBox?.height === undefined ? false : searchBox.height >= 44,
      `group=效果 height=${Math.round(searchBox?.height ?? 0)}`,
    )
    await page.getByRole('button', { name: '清除参数搜索' }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.panel-groups .panel-group').length === 13,
      null,
      { timeout: 5_000 },
    )
    check(
      `${viewport.name} · 清除搜索后十三组恢复`,
      await searchInput.inputValue() === '',
      'groups=13 value=""',
    )

    await page.locator('.tool-row-main [aria-label="磨皮"]').click()
    await page.waitForSelector('.tool-row-second', { timeout: 10_000 })
    const smoothing = await scanVisibleTargets(page)
    check(
      `${viewport.name} · 磨皮工具每个可见控件有 44px 命中区`,
      smoothing.failures.length === 0,
      `tested=${smoothing.tested} failures=${JSON.stringify(smoothing.failures)}`,
    )

    const photo = await page.locator('canvas.canvas').boundingBox()
    check(
      `${viewport.name} · 补命中区后照片仍可编辑`,
      !!photo && photo.width >= 240 && photo.height >= 150,
      `${Math.round(photo?.width ?? 0)}×${Math.round(photo?.height ?? 0)}`,
    )

    await page.locator('.tool-row-main [aria-label="裁剪"]').click()
    const cropFrame = page.locator('.crop-frame')
    await cropFrame.waitFor({ state: 'visible', timeout: 10_000 })
    const cropTargets = await scanVisibleTargets(page, '.app .crop-frame, .app .crop-h')
    check(
      `${viewport.name} · 裁剪把手每个可见控件有 44px 命中区`,
      cropTargets.failures.length === 0,
      `tested=${cropTargets.tested} failures=${JSON.stringify(cropTargets.failures)}`,
    )
    const cropHandle = page.locator('.crop-h[data-h="se"]')
    await cropHandle.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowUp')
    await cropFrame.focus()
    const cropBefore = await cropFrame.boundingBox()
    await page.keyboard.press('ArrowRight')
    const cropAfterKey = await cropFrame.boundingBox()
    const keyboardDX = (cropAfterKey?.x ?? 0) - (cropBefore?.x ?? 0)
    check(
      `${viewport.name} · 裁剪框可用方向键精确移动`,
      keyboardDX >= 0.5 && keyboardDX <= 2,
      `dx=${keyboardDX.toFixed(2)}px`,
    )
    await page.keyboard.press('Shift+ArrowDown')
    const cropAfterShift = await cropFrame.boundingBox()
    const keyboardDY = (cropAfterShift?.y ?? 0) - (cropAfterKey?.y ?? 0)
    check(
      `${viewport.name} · Shift + 方向键可加速移动`,
      keyboardDY >= 8 && keyboardDY <= 12,
      `dy=${keyboardDY.toFixed(2)}px`,
    )
    await cropHandle.focus()
    const sizeBefore = await cropFrame.boundingBox()
    await page.keyboard.press('Shift+ArrowRight')
    const sizeAfter = await cropFrame.boundingBox()
    const keyboardDW = (sizeAfter?.width ?? 0) - (sizeBefore?.width ?? 0)
    check(
      `${viewport.name} · 裁剪把手可用键盘调整大小`,
      keyboardDW >= 8 && keyboardDW <= 12,
      `dw=${keyboardDW.toFixed(2)}px`,
    )

    await page.getByRole('button', { name: '透视', exact: true }).click()
    const perspectiveHandle = page.locator('.perspective-handle').first()
    await perspectiveHandle.waitFor({ state: 'visible', timeout: 10_000 })
    const perspectiveTargets = await scanVisibleTargets(
      page, '.app .perspective-handle',
    )
    check(
      `${viewport.name} · 透视四角每个都有 44px 命中区`,
      perspectiveTargets.failures.length === 0,
      `tested=${perspectiveTargets.tested} failures=${JSON.stringify(perspectiveTargets.failures)}`,
    )
    await perspectiveHandle.focus()
    const perspectiveBefore = await perspectiveHandle.boundingBox()
    await page.keyboard.press('ArrowRight')
    const perspectiveAfterKey = await perspectiveHandle.boundingBox()
    const perspectiveDX = (perspectiveAfterKey?.x ?? 0) - (perspectiveBefore?.x ?? 0)
    check(
      `${viewport.name} · 透视角可用方向键精确移动`,
      perspectiveDX >= 0.5 && perspectiveDX <= 2,
      `dx=${perspectiveDX.toFixed(2)}px`,
    )
    await page.keyboard.press('Shift+ArrowDown')
    const perspectiveAfterShift = await perspectiveHandle.boundingBox()
    const perspectiveDY = (perspectiveAfterShift?.y ?? 0) - (perspectiveAfterKey?.y ?? 0)
    check(
      `${viewport.name} · 透视角 Shift + 方向键可加速`,
      perspectiveDY >= 8 && perspectiveDY <= 12,
      `dy=${perspectiveDY.toFixed(2)}px`,
    )

    await page.locator('.crop-tools button', { hasText: '取消' }).click()
    await page.locator('.tool-row-main [aria-label="人像"]').click()
    await page.getByRole('button', { name: '重选脸', exact: true }).click()
    const manualFace = page.locator('.face-pick')
    await manualFace.waitFor({ state: 'visible', timeout: 10_000 })
    check(
      `${viewport.name} · 手动圈脸自动聚焦且有键盘说明`,
      await manualFace.evaluate(el => document.activeElement === el)
        && (await manualFace.innerText()).includes('按 Enter'),
      (await manualFace.innerText()).slice(0, 70),
    )
    await page.keyboard.press('Enter')
    await page.locator('.face-pick-frame').waitFor({
      state: 'visible',
      timeout: 5_000,
    })
    check(
      `${viewport.name} · 手动圈脸可用 Enter 放置脸框`,
      (await manualFace.innerText()).includes('Enter 确定'),
      (await manualFace.innerText()).slice(0, 70),
    )

    check(
      `${viewport.name} · 无横向溢出`,
      !await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
      'overflow=false',
    )
    check(
      `${viewport.name} · 控制台无错误`,
      errors.length === 0,
      errors.length ? errors.slice(0, 2).join(' | ') : '无错误',
    )
    await page.keyboard.press('Escape')
    await page.locator('.tool-row-second .crop-tools button', { hasText: '取消' }).click()
    await page.locator('.nav-item', { hasText: '修图' }).first().click()
    await page.waitForSelector('.chat-input', { timeout: 10_000 })
    await context.setOffline(true)
    await page.getByText('当前离线。', { exact: false }).waitFor({
      state: 'visible',
      timeout: 5_000,
    })
    check(
      `${viewport.name} · 断网时明确说明本地仍可修图`,
      (await page.locator('.notice').innerText()).includes('本地修图、裁剪和导出照常'),
      (await page.locator('.notice').innerText()).slice(0, 80),
    )
    check(
      `${viewport.name} · 断网时 AI 发送明确禁用`,
      await page.locator('.chat-input button[type="submit"]').isDisabled()
        && (await page.locator('.chat-offline').innerText()).includes('AI 对话与生成需要联网'),
      await page.locator('.chat-offline').innerText(),
    )
    await context.setOffline(false)
    await page.getByText('网络恢复了', { exact: false }).waitFor({
      state: 'visible',
      timeout: 5_000,
    })
    check(
      `${viewport.name} · 恢复网络后给出明确回执`,
      (await page.locator('.notice').innerText()).includes('可以继续用 AI'),
      (await page.locator('.notice').innerText()).slice(0, 80),
    )
    check(
      `${viewport.name} · 恢复网络后 AI 发送重新可用`,
      await page.locator('.chat-input button[type="submit"]').isEnabled()
        && await page.locator('.chat-offline').count() === 0,
      'send=enabled offlineNote=hidden',
    )
    await context.close()
  }
} finally {
  await browser.close()
}

const failed = checks.filter(item => !item.ok)
console.log(`\n${failed.length ? '❌' : '✅'} ${checks.length - failed.length}/${checks.length} 条通过`)
if (failed.length) process.exitCode = 1
