#!/usr/bin/env node
/**
 * 小程序冒烟 + 「全黑哨兵」（Task 7）。
 *
 * 为什么是它：**GLSL 编不过 = 每张照片全黑** —— typecheck / 构建 / 单测四样全瞎
 * （电脑版 2026-10-05 真机抓到过一次；来路写在 src/render/shader.ts 顶上）。
 * 只有「真渲染 + 读像素数颜色」抓得到：纯色画布（全黑 / 全白）就是静默失败。
 *
 * 前置：
 *   1) 微信开发者工具已用 CLI 起着（mini/README.md「冒烟」那节有完整命令）；
 *   2) 镜像与电脑版源头一致 —— 脚本自己先跑
 *      `node scripts/sync-mini-shared.mjs --check`，不一致直接失败退出（别测漂的镜像）。
 *
 * 流程：连模拟器 →（进主页面 →）点**仅开发版可见**的「载入测试照片」按钮（dev 通道，
 *       照片是打进包的 assets/test-photo.jpg）→ 等风格栏就绪 → 对 13 档
 *       （原图 + 12 预设）逐档：点那一格 → 确认点亮 → `__probeColors()` 数颜色。
 *
 * 断言（哨兵本体）：
 *   ① 每档 colors > 1（纯色 = 全黑/全白的静默失败，也兜住"根本没建起管线"的 0）；
 *   ② 每档 err === 0（gl.getError，探针里每档读一次，读完清账）；
 *   ③ 「原图」与「黑白」两档 first 不相同（证明真的在按风格渲染，不是都在画同一张）。
 * 失败：存截图 + 打印每档 colors/first/err，exit 1。全过 exit 0。
 *
 * 用法（CLI 已起着）：node mini/scripts/smoke.cjs
 *
 * ⚠️ 连接与交互招式照 archive/spike/miniprogram-webgl/run-probe.cjs：
 *   外面的 PowerShell 起好 CLI（--auto-port 9420）、这里只 connect；
 *   探测走「点按钮 + 轮询 page.data()」，别拿 callMethod 去等长任务
 *   （`__probeColors` 是纯读、同步、立即返回，够快，才敢这么调）。
 * ⚠️ 这跑的是**模拟器**（电脑显卡）：它筛得掉编不过的着色器，答不了"真机跑不跑得动"。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..', '..') // 仓库根（同步脚本在它下面）
const OUT = path.join(ROOT, '.superpowers', 'mini') // 截图落这（和别的探针同处）
const ENDPOINT = process.env.WS ?? 'ws://127.0.0.1:9420'
/** 单个 automator 调用的上限 —— **每个调用都要套 rpc()**：会话半死时 RPC 会永远
 *  不返回（2026-10-12 真卡死过一次；Windows 上外层的 `timeout` 还杀不掉 node）。
 *  超时就把「卡在哪一步」写进错误里，脚本失败退出，绝不死等。 */
const RPC_MS = 30000
/** 整条冒烟的保险丝（正常 1~2 分钟跑完；这只是兜底，防"某个 await 没被套上"）。 */
const WATCHDOG_MS = 240000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const withTimeout = (p, ms, name) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(name + ' TIMEOUT ' + ms + 'ms')), ms))])
const rpc = (p, name, ms = RPC_MS) => withTimeout(p, ms, 'automator ' + name)
const log = (...a) => console.log(...a)

const stamp = () => {
  const t = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' —— ' + detail : ''))
}

/** 轮询 page.data() 直到满足，超时就把最后一拍的数据还回去（断言那边自己判）。
 *  每次取值也走 rpc()（会话半死时不至于停在这一句上）。 */
async function waitData(page, pred, ms) {
  const t0 = Date.now()
  let d = {}
  while (Date.now() - t0 < ms) {
    d = await rpc(page.data(), 'page.data')
    if (pred(d)) return d
    await sleep(200)
  }
  return d
}

/** 截图：**证据、不是判据** —— mp.screenshot 偶发工具侧超时（Task 5/6 记过），失败只记一笔。 */
async function shot(mp, name) {
  const p = path.join(OUT, name + '-' + stamp() + '.png')
  try {
    fs.mkdirSync(OUT, { recursive: true })
    await withTimeout(mp.screenshot({ path: p }), 30000, 'shot')
    log('  [shot]', p)
  } catch (e) {
    log('  [shot-FAIL]', name, e && e.message)
  }
}

;(async () => {
  // 保险丝：整条冒烟超过上限直接退（码 2）—— 2026-10-12 卡死过一次：会话半死时
  // RPC 永远不返回，而 Windows 上外层的 `timeout` 杀不掉 node，屏幕上一点动静都没有。
  // 正常跑 1~2 分钟；每个调用另有 rpc() 的单项上限，这条只是兜底。
  setTimeout(() => {
    log('\n✖ 看门狗：整条冒烟超过 ' + (WATCHDOG_MS / 1000) + ' 秒还没跑完 —— 不傻等，直接退（码 2）。' +
      '多半是模拟器/automator 会话卡住了：按 mini/README.md「冒烟」重启 CLI 再跑。')
    process.exit(2)
  }, WATCHDOG_MS)

  // ── [0] 前置守卫：镜像漂了就别测（Task 2 的 --check 挂上位的地方）──────────
  log('[0] 前置守卫：node scripts/sync-mini-shared.mjs --check')
  const guard = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'sync-mini-shared.mjs'), '--check'], { stdio: 'inherit' })
  if (guard.status !== 0) {
    log('✖ 守卫没过（exit=' + guard.status + '）—— 镜像与源头不一致，先跑一遍同步再来测。')
    process.exit(1)
  }

  // ── [1] 连模拟器 ──────────────────────────────────────────────────────────
  log('\n[1] 连模拟器', ENDPOINT, '…')
  let mp
  try {
    mp = await rpc(automator.connect({ wsEndpoint: ENDPOINT }), 'connect', 20000)
  } catch (e) {
    throw new Error('连不上 ' + ENDPOINT + ' —— CLI 起了吗？（mini/README.md「冒烟」那节）原始错误：' + (e && e.message ? e.message : e))
  }
  mp.on('console', m => log('   [mini console]', typeof m === 'object' ? JSON.stringify(m).slice(0, 400) : String(m).slice(0, 400)))
  mp.on('exception', e => log('   [mini exception]', JSON.stringify(e).slice(0, 600)))

  const page = await rpc(mp.currentPage(), 'currentPage')
  log('[2] 当前页面:', page.path)
  if (page.path !== 'pages/index/index') throw new Error('不在主页面（' + page.path + '）—— 让模拟器回到 pages/index/index 再跑')

  // 上一次跑完可能停在编辑态：先「换一张」回空态（dev 按钮在空态那张屏上）
  let d = await rpc(page.data(), 'page.data')
  if (d.stage === 'edit') {
    const back = await rpc(page.$('.tb-left'), '$ .tb-left')
    if (!back) throw new Error('停在编辑态却找不到「换一张」（.tb-left）')
    await rpc(back.tap(), 'tap 换一张')
    d = await waitData(page, x => x.stage === 'empty', 8000)
  }
  if (d.stage !== 'empty') throw new Error('回不到空态：stage=' + d.stage)

  // ── [3] dev 按钮（只有开发版才有）→ 载入测试照片 ───────────────────────────
  log('[3] 空态。dev 标记 =', d.dev)
  const devBtn = await rpc(page.$('.dev-btn'), '$ .dev-btn')
  if (!devBtn) {
    throw new Error('页面上没有 dev 按钮（data.dev=' + d.dev + '）—— 环境不是开发版？还是页面没重编译' +
      '（改过页面代码要先重启 CLI：cli quit → 等端口消失 → auto，见 README）')
  }
  await rpc(devBtn.tap(), 'tap dev')
  log('[4] 已点「载入测试照片」，等渲染 + 风格栏就绪 …')
  d = await waitData(page, x => x.stage === 'edit' && x.styles.length > 0 && !!x.spritePath, 60000)
  const ready = d.stage === 'edit' && d.styles.length === 13 && !!d.spritePath
  if (!ready) {
    // 渲染管线没建起来（比如着色器编不过）时，路就停在这儿 —— 把现场整个打出来
    log('  ✖ 风格栏没就绪：', JSON.stringify({
      stage: d.stage, photo: d.photo, photoW: d.photoW, photoH: d.photoH,
      styles: d.styles.length, spritePath: d.spritePath, activeStyle: d.activeStyle,
    }))
    try { log('  __probeColors() =', JSON.stringify(await rpc(page.callMethod('__probeColors'), 'callMethod __probeColors'))) }
    catch (e) { log('  __probeColors() 也调不动：', e && e.message) }
    check('渲染 + 风格栏就绪（stage=edit、13 格、spritePath 非空）', false, '等 60 秒也没齐')
    await shot(mp, 'smoke-fail')
  } else {
    check('渲染 + 风格栏就绪（stage=edit、13 格、spritePath 非空）', true,
      'photoW×H=' + d.photoW + '×' + d.photoH + ' styles=' + d.styles.length)
  }

  // ── [5] 13 档逐档：点那一格 → 确认点亮 → 数颜色 ────────────────────────────
  if (ready) {
    const ids = d.styles.map(c => c.id)
    check('第一格是「原图」(original)', ids[0] === 'original', 'ids[0]=' + ids[0])
    check('里面有「黑白」(bw)', ids.includes('bw'), 'ids=' + ids.join(','))
    log('[5] 逐档点选 + 数颜色（' + ids.length + ' 档 = 原图 + ' + (ids.length - 1) + ' 预设）')
    const probe = {}
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      // 每次都重查格子（上一次 tap 后 setData 换过选中态）—— 顺序 = styles 的数组顺序（Task 6 验过）
      const cells = await rpc(page.$$('.style-cell'), '$$ .style-cell')
      if (cells.length !== ids.length) throw new Error('格子数不对：' + cells.length + ' ≠ ' + ids.length)
      await rpc(cells[i].tap(), 'tap 第 ' + (i + 1) + ' 格')
      const dd = await waitData(page, x => x.activeStyle === id, 8000)
      check('点第 ' + (i + 1) + ' 格「' + d.styles[i].label + '」点亮 = ' + id, dd.activeStyle === id, 'activeStyle=' + dd.activeStyle)
      const p = await rpc(page.callMethod('__probeColors'), 'callMethod __probeColors') // 纯读、同步、立即返回
      probe[id] = p
      log('   [' + (i + 1) + '/' + ids.length + '] ' + id + ' colors=' + p.colors + ' first=' + p.first + ' err=' + p.err)
      check('  ① ' + id + ' colors > 1（不是纯色）', p.colors > 1, 'colors=' + p.colors)
      check('  ② ' + id + ' err === 0', p.err === 0, 'err=' + p.err)
    }
    // ③ 相邻差异：原图 vs 黑白 —— first 必须不同（两档画的是同一张的话这条会红）
    const a = probe.original, b = probe.bw
    if (a && b) check('  ③ 「原图」与「黑白」first 不相同', a.first !== b.first, 'original=' + a.first + '  bw=' + b.first)
    else check('  ③ 「原图」与「黑白」两档都取到了', false, 'original=' + JSON.stringify(a) + ' bw=' + JSON.stringify(b))
    await shot(mp, 'smoke-ok')
  }

  // ── 收尾：汇总 + 退出码 ──────────────────────────────────────────────────
  try { await rpc(mp.disconnect(), 'disconnect', 10000) } catch (e) { /* 没连上也就算了 */ }
  const fail = results.filter(r => !r.ok)
  log('\n══════ 汇总：' + (results.length - fail.length) + '/' + results.length + ' 过 ══════')
  if (fail.length) {
    fail.forEach(f => log('  ❌ ' + f.name))
    if (ready) log('（每档的 colors/first/err 都在上面；截图见 .superpowers/mini/smoke-fail-*.png / smoke-ok-*.png）')
    process.exit(1)
  }
  process.exit(0)
})().catch(e => {
  console.error('FATAL:', e && e.message ? e.message : e)
  process.exit(1)
})
