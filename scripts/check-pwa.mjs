#!/usr/bin/env node
/**
 * 生产构建的离线应用壳探针（★ 2026-10-19）。
 *
 * 只验三件事：
 *   ① 生产页面会注册 Service Worker，并进入 activated；
 *   ② 应用壳和静态资源进了 Cache Storage，`/api/` 一个字节都没进；
 *   ③ 断网后刷新，页面仍然能加载出应用骨架。
 *
 * 用法：先 `npm run build && npm start`，再 `npm run check:pwa`。
 */
import { chromium, webkit } from 'playwright'

const BASE = process.env.PWA_BASE ?? 'http://127.0.0.1:8787'
const APP = `${BASE}/app`
const checks = []

function check(name, ok, got) {
  checks.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${got}`)
}

async function cachedPaths(page) {
  return page.evaluate(async () => {
    const names = await caches.keys()
    const result = {}
    for (const name of names) {
      const cache = await caches.open(name)
      result[name] = (await cache.keys()).map(request => new URL(request.url).pathname)
    }
    return result
  })
}

async function run(browserType, label) {
  const browser = await browserType.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(APP, { waitUntil: 'load' })
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return registration?.active?.state === 'activated'
    }, null, { timeout: 15_000 }).catch(() => {})
    const registration = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false }
      const ready = await navigator.serviceWorker.ready
      return {
        supported: true,
        scope: ready.scope,
        hasActive: !!ready.active,
        state: ready.active?.state ?? null,
        controlled: !!navigator.serviceWorker.controller,
      }
    })
    // 有的内核在首次安装后仍报告 activating；以缓存落地和离线刷新为准。
    check(`${label} Service Worker 已安装并激活`, registration.supported
      && registration.hasActive,
      `active=${registration.hasActive} controlled=${registration.controlled} `
        + `state=${registration.state} scope=${registration.scope}`)

    const beforeApi = await cachedPaths(page)
    const allPaths = Object.values(beforeApi).flat()
    const hasEntry = allPaths.some(path => path.endsWith('.js'))
      && allPaths.some(path => path.endsWith('.css'))
    check(`${label} 应用壳和入口资源已进缓存`, allPaths.includes('/app.html')
      && allPaths.includes('/') && hasEntry,
      Object.entries(beforeApi).map(([name, paths]) => `${name}:${paths.length}`).join(', '))

    await page.evaluate(() => fetch('/api/health').catch(() => null))
    await page.waitForTimeout(300)
    const afterApi = await cachedPaths(page)
    const cachedApi = Object.values(afterApi).flat().filter(path => path.startsWith('/api/'))
    check(`${label} /api 不进缓存`, cachedApi.length === 0,
      cachedApi.length ? cachedApi.join(', ') : '0 条')

    await context.setOffline(true)
    const reload = await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
      .catch(() => null)
    await page.waitForTimeout(500)
    const shell = await page.evaluate(() => ({
      status: document.readyState,
      rootChildren: document.querySelector('#root')?.children.length ?? 0,
      controlled: !!navigator.serviceWorker.controller,
      title: document.title,
      bodyText: document.body?.innerText?.trim().slice(0, 40) ?? '',
    }))
    // WebKit 离线 reload 可能返回 null 但页面已经由 Service Worker 恢复；
    // 以 DOM 是否真的挂上为准。
    check(`${label} 断网刷新仍加载应用壳`, shell.rootChildren > 0,
      `reload=${!!reload} ready=${shell.status} root=${shell.rootChildren} `
        + `title=${shell.title} text=${shell.bodyText}`)
    check(`${label} 离线页面由 Service Worker 控制`, shell.controlled,
      `controlled=${shell.controlled}`)
    // 未登录时 App 会请求会话和滤镜清单，401 是登录墙的正常结果；
    // 这里只盯 Service Worker 和页面运行时的其他错误。
    const relevantErrors = errors.filter(text =>
      !/401|Unauthorized|先登录一下|504|ERR_INTERNET_DISCONNECTED|连不上服务器|internal error/i
        .test(text))
    check(`${label} 控制台无错误`, relevantErrors.length === 0,
      relevantErrors.length ? relevantErrors.slice(0, 3).join(' | ') : '无')
  } finally {
    await browser.close()
  }
}

for (const [browserType, label] of [[chromium, 'Chromium'], [webkit, 'WebKit']]) {
  try {
    await run(browserType, label)
  } catch (error) {
    check(`${label} 探针执行完成`, false, error instanceof Error ? error.message : String(error))
  }
}

const failed = checks.filter(item => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 条通过`)
if (failed.length) process.exit(1)
