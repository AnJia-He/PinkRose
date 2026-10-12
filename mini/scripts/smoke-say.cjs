#!/usr/bin/env node
/**
 * 「说一句」全流程的冒烟（Task 12）—— 对着**本地 mock 后端**（mock-server.cjs，4399）
 * 跑，真钱一分不花。和 smoke.cjs（全黑哨兵）**分开两个文件**：那条链测的是"渲染
 * 出没出画"，这条测的是"一句话怎么分流、怎么等、怎么停、怎么撤" —— 混在一个
 * 文件里，任何一边红了都看不出是哪条链断的，还互相拖时间。
 *
 * 前置（和 smoke.cjs 同款）：
 *   1) 微信开发者工具已用 CLI 起着（mini/README.md「冒烟」那节有命令）；
 *   2) mock 服务器**不用手动起** —— 脚本自己 spawn（4399 已有别人起着的就直接用，
 *      跑完也不杀它）；环境里 MOCK_ROUTE_MS=1200 / MOCK_EDIT_MS=800 是起它的参数。
 *
 * 故事线（六个场景，四种决策路 + 停止）：
 *   A params   「亮一点」      —— 输入条「在想…」（不弹蒙层）→ 参数叠加 + 点亮「通透提亮」
 *                                + 浮条（原文）→ 5 秒淡出
 *   B generate 「把路人去掉」   —— 蒙层（秒数前 5 秒不带数字）→ 新图（尺寸换成 mock 那张）
 *                                → 浮条 + 撤销 → 点撤销 → 画面和参数都回到发前 + 采样点/色数还原
 *   C both     「亮一点再去掉路人」—— 蒙层**期间**就能读到参数已生效（contrast +20），
 *                                生成完 → 撤销把"参数+底图"一起还原（一层）
 *   D degraded 「随便修一下」   —— 浮条拼上"拿不太准"提醒（电脑版口径）
 *   E 拿不准   「把那个人去掉」 —— 参数照收（exposure +6）、生成拦住、没有蒙层、撤销没被动过
 *   F 停止     改 mock 延时到 20s —— 秒表 5 秒内不带数字、5 秒后「已经等了 N 秒」；
 *                                点「停止」→ 请求真掐断（mock 的 editAborted 计数为证）、
 *                                画面/参数/撤销原样、浮条「停了。」
 *
 * 用法（CLI 已起着）：node mini/scripts/smoke-say.cjs
 *
 * ⚠️ 防挂死纪律（Task 7 卡死那次的教训，smoke.cjs 同款）：每个 automator 调用套
 *    rpc() 上限、每处轮询有上限、整条有看门狗。截图是**证据不是判据**。
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..', '..') // 仓库根（同步脚本在它下面）
const OUT = path.join(ROOT, '.superpowers', 'mini') // 截图落这（和别的探针同处）
const ENDPOINT = process.env.WS ?? 'ws://127.0.0.1:9420'
const MOCK_PORT = 4399
const MOCK = 'http://127.0.0.1:' + MOCK_PORT
const RPC_MS = 30000
/** 整条冒烟的保险丝（六个场景正常 1.5~3 分钟；只是兜底，防"某个 await 没被套上"）。 */
const WATCHDOG_MS = 300000
/** 路由阶段的 mock 延时 —— 调大到 1200ms 才看得见「在想…」（真后端 1.3~1.6s 同量级） */
const ROUTE_MS = 1200
/** A~E 场景的生成延时（短，跑得快） */
const EDIT_MS = 800
/** F（停止 + 秒表）的生成延时 —— 要长到"5 秒换挡看到秒数、截图、再点停止"都在窗口里
 *  （截图慢的时候能吃掉好几秒，14s 曾差点不够，留 20s 的余量） */
const EDIT_MS_LONG = 20000

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

/** 轮询 page.data() 直到满足，超时就把最后一拍的数据还回去（断言那边自己判）。 */
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

/** 截图：**证据、不是判据** —— mp.screenshot 偶发工具侧超时，失败只记一笔。 */
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

// ── mock 服务器的小工具 ──────────────────────────────────────────────────────
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(MOCK + pathname, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('mock 请求超时')))
  })
}
async function mockUp() {
  try { const h = await getJson('/mock/health'); return !!(h && h.ok) } catch { return false }
}

;(async () => {
  // 保险丝：整条超过上限直接退（码 2）—— 不傻等（smoke.cjs 同款理由）。
  setTimeout(async () => {
    log('\n✖ 看门狗：整条冒烟超过 ' + (WATCHDOG_MS / 1000) + ' 秒还没跑完 —— 收尾后直接退（码 2）。')
    // ★ M5（2026-10-12 全支大审）：`process.exit` 会**跳过 finally** —— 这里先补
    //   收尾：API 地址必须指回 config（它是运行期全局开关，留着会把模拟器之后的
    //   一切请求都打到 mock，症状只有"连不上"，很难查）；mock 是本脚本 spawn 的
    //   子进程，退出前也顺手杀掉（不然它留在 4399 上）。
    try { if (page) await rpc(page.callMethod('__probeSetApiBase', ''), 'watchdog reset api base', 8000) } catch (e) { log('  [warn] 看门狗里 API 地址没能指回 config：', e && e.message) }
    if (mockProc) mockProc.kill()
    process.exit(2)
  }, WATCHDOG_MS)

  // ── [0] 前置守卫：镜像漂了就别测（和 smoke.cjs 同一条）─────────────────────
  log('[0] 前置守卫：node scripts/sync-mini-shared.mjs --check')
  const guard = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'sync-mini-shared.mjs'), '--check'], { stdio: 'inherit' })
  if (guard.status !== 0) {
    log('✖ 守卫没过（exit=' + guard.status + '）—— 镜像与源头不一致，先跑一遍同步再来测。')
    process.exit(1)
  }

  // ── [1] 起 mock（已有别人起着的就直接用）──────────────────────────────────
  let mockProc = null
  if (await mockUp()) {
    log('[1] 4399 上已经有一个 mock 在跑（不是本脚本起的）—— 直接用它，跑完不杀')
  } else {
    log('[1] 起 mock：node mini/scripts/mock-server.cjs（routeMs=' + ROUTE_MS + ' editMs=' + EDIT_MS + '）')
    mockProc = spawn(process.execPath, [path.join(__dirname, 'mock-server.cjs')], {
      env: { ...process.env, MOCK_ROUTE_MS: String(ROUTE_MS), MOCK_EDIT_MS: String(EDIT_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    mockProc.stdout.on('data', c => log('   [mock]', String(c).trim()))
    mockProc.stderr.on('data', c => log('   [mock-err]', String(c).trim()))
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = await mockUp() }
    if (!up) throw new Error('mock 起不来（' + MOCK + '）—— 端口被别的程序占了？')
  }
  // 两种延时**每趟都归一**：复用别人起着的 mock 时，它身上的延时可能是上一趟留下的
  await getJson('/mock/set?routeMs=' + ROUTE_MS + '&editMs=' + EDIT_MS)
  const health = await getJson('/mock/health')
  const mockW = health.width
  const mockH = health.height
  log('[1] mock 就绪：生成结果照片 ' + health.photo + '（' + mockW + '×' + mockH + '）')

  // ── [2] 连模拟器 ──────────────────────────────────────────────────────────
  log('\n[2] 连模拟器', ENDPOINT, '…')
  let mp = null
  let page = null
  try {
    try {
      mp = await rpc(automator.connect({ wsEndpoint: ENDPOINT }), 'connect', 20000)
    } catch (e) {
      throw new Error('连不上 ' + ENDPOINT + ' —— CLI 起了吗？（mini/README.md「冒烟」那节）原始错误：' + (e && e.message ? e.message : e))
    }
    mp.on('console', m => log('   [mini console]', typeof m === 'object' ? JSON.stringify(m).slice(0, 400) : String(m).slice(0, 400)))
    mp.on('exception', e => log('   [mini exception]', JSON.stringify(e).slice(0, 600)))

    page = await rpc(mp.currentPage(), 'currentPage')
    log('[2] 当前页面:', page.path)
    if (page.path !== 'pages/index/index') throw new Error('不在主页面（' + page.path + '）')

    // 清掉上个探针/上次跑留下的票（确定性：让这一趟自己走一遍静默登录 →
    // mock 的 /api/wx-login），再把 API 地址指到 mock。
    await rpc(mp.evaluate(() => { wx.clearStorageSync() }), 'clearStorage')
    await rpc(page.callMethod('__probeSetApiBase', MOCK), 'setApiBase')

    // 上一次可能停在编辑态：先「换一张」回空态。
    let d = await rpc(page.data(), 'page.data')
    if (d.stage === 'edit') {
      const back = await rpc(page.$('.tb-left'), '$ .tb-left')
      if (!back) throw new Error('停在编辑态却找不到「换一张」（.tb-left）')
      await rpc(back.tap(), 'tap 换一张')
      d = await waitData(page, x => x.stage === 'empty', 8000)
    }
    if (d.stage !== 'empty') throw new Error('回不到空态：stage=' + d.stage)

    // ── [3] dev 通道载入测试照片（绕开系统选图弹窗）─────────────────────────
    log('[3] 载入测试照片 …')
    const devBtn = await rpc(page.$('.dev-btn'), '$ .dev-btn')
    if (!devBtn) throw new Error('页面上没有 dev 按钮（非开发版？或改过页面代码还没重编译 —— cli quit → auto）')
    await rpc(devBtn.tap(), 'tap dev')
    d = await waitData(page, x => x.stage === 'edit' && x.styles.length === 13 && !!x.spritePath, 60000)
    const ready = d.stage === 'edit' && d.styles.length === 13 && !!d.spritePath
    check('渲染 + 风格栏就绪（说一句的前置）', ready,
      'photoW×H=' + d.photoW + '×' + d.photoH + ' styles=' + d.styles.length)
    if (!ready) {
      await shot(mp, 'smoke-say-fail')
      throw new Error('风格栏没就绪，后面的场景没法跑')
    }
    const photo0 = d.photo
    const photoW0 = d.photoW
    const photoH0 = d.photoH

    // 探针小工具：同步读——参数（__probeParams）/ 颜色（__probeColors）
    const params = async () => rpc(page.callMethod('__probeParams'), 'callMethod __probeParams')
    const colors = async () => rpc(page.callMethod('__probeColors'), 'callMethod __probeColors')
    const say = async (text) => {
      await rpc(page.setData({ sayText: text }), 'setData sayText')
      const btn = await rpc(page.$('.say-send'), '$ .say-send')
      if (!btn) throw new Error('找不到发送箭头（.say-send）—— 页面没重编译？')
      await rpc(btn.tap(), 'tap 发送')
    }

    // ── [A] params：「亮一点」→ 本地套参数 + 点亮 + 浮条（先「在想…」）─────────
    log('\n[A] params 路：「亮一点」')
    const aColors0 = await colors()
    await say('亮一点')
    const dR = await waitData(page, x => x.sayBusy === true, 2500)
    check('A1 发送后输入条进「在想…」，且这段**不弹蒙层**',
      dR.sayBusy === true && dR.sayBusyText === '在想…' && dR.generating === false,
      'busy=' + dR.sayBusy + ' text=' + dR.sayBusyText + ' generating=' + dR.generating)
    const dA = await waitData(page, x => x.activeStyle === 'bright', 8000)
    // 点亮「通透提亮」= 15 个参数**全等**那套预设（共享 activePresetId 的判据），
    // 一句话把这个决策的参数半证死。
    check('A2 参数叠加生效：点亮「通透提亮」(bright)', dA.activeStyle === 'bright',
      'activeStyle=' + dA.activeStyle)
    const aParams = await params()
    check('A3 参数真的是增量叠出来的（exposure=16、saturation=6）',
      aParams.exposure === 16 && aParams.saturation === 6,
      'exposure=' + aParams.exposure + ' saturation=' + aParams.saturation)
    const aColors1 = await colors()
    check('A4 画面真的变了（采样点变了）', aColors1.first !== aColors0.first,
      aColors0.first + ' → ' + aColors1.first)
    const dB = await waitData(page, x => x.sayBubble !== '', 6000)
    check('A5 浮条显示模型那句话（原文）', dB.sayBubble === '好，我把照片调成了通透提亮的样子。',
      JSON.stringify(dB.sayBubble))
    check('A6 参数路浮条出现这一刻没有蒙层（单拍 generating=false）', dB.generating === false,
      'generating=' + dB.generating)
    await shot(mp, 'say-A-params')
    const dFade = await waitData(page, x => x.sayBubble === '', 7500)
    check('A7 浮条 ~5 秒自动淡出', dFade.sayBubble === '', 'sayBubble=' + JSON.stringify(dFade.sayBubble))

    // ── [B] generate：「把路人去掉」→ 蒙层 → 新图 → 撤销 → 还原 ───────────────
    log('\n[B] generate 路：「把路人去掉」')
    const bColors0 = await colors()
    const bParams0 = await params()
    await say('把路人去掉')
    const dMask = await waitData(page, x => x.generating === true, 6000)
    check('B1 进生成：蒙层亮、秒表开头不带数字（5 秒内不显示秒数）',
      dMask.generating === true && dMask.genText === '正在修…' && !/[0-9]/.test(dMask.genText),
      'genText=' + JSON.stringify(dMask.genText))
    check('B2 生成期间输入条是「正在修…」', dMask.sayBusy === true && dMask.sayBusyText === '正在修…',
      'busyText=' + dMask.sayBusyText)
    await shot(mp, 'say-B-mask')
    const dBdone = await waitData(page, x => x.generating === false && x.canUndo === true, 9000)
    check('B3 生成完直接换图（尺寸换成 mock 那张）',
      dBdone.photoW === mockW && dBdone.photoH === mockH,
      'photoW×H=' + dBdone.photoW + '×' + dBdone.photoH + '（mock 那张 ' + mockW + '×' + mockH + '）')
    check('B4 右下角「撤销」亮了', dBdone.canUndo === true, 'canUndo=' + dBdone.canUndo)
    const dBubble = await waitData(page, x => x.sayBubble !== '', 4000)
    check('B5 reply 和图片一起到（浮条原文）', dBubble.sayBubble === '好，这就把背景里的路人去掉。',
      JSON.stringify(dBubble.sayBubble))
    const bColors1 = await colors()
    check('B6 新图的像素真的不一样', bColors1.first !== bColors0.first, bColors0.first + ' → ' + bColors1.first)
    await shot(mp, 'say-B-done')
    // 点撤销
    const undoBtn = await rpc(page.$('.undo-btn'), '$ .undo-btn')
    if (!undoBtn) throw new Error('找不到「撤销」（.undo-btn）')
    await rpc(undoBtn.tap(), 'tap 撤销')
    const dUndo = await waitData(page, x => x.canUndo === false && x.photo === photo0, 6000)
    check('B7 撤销：底图回到发前那张', dUndo.photo === photo0 && dUndo.photoW === photoW0,
      'photo=' + dUndo.photo)
    const bParams1 = await params()
    check('B8 撤销：参数也回到发前', JSON.stringify(bParams1) === JSON.stringify(bParams0),
      JSON.stringify(bParams1) === JSON.stringify(bParams0) ? '' : JSON.stringify(bParams1))
    const bColors2 = await colors()
    check('B9 撤销后采样点 + 色数还原（16×16 网格：首采样点、颜色数双双相同）',
      bColors2.first === bColors0.first && bColors2.colors === bColors0.colors,
      bColors0.first + '/' + bColors0.colors + '色 vs ' + bColors2.first + '/' + bColors2.colors + '色')
    check('B10 撤销完按钮收掉（一层）', dUndo.canUndo === false, 'canUndo=' + dUndo.canUndo)
    await shot(mp, 'say-B-undone')

    // ── [C] both：「亮一点再去掉路人」→ 参数先落地（蒙层期间就能读到）→ 一起撤销 ──
    log('\n[C] both 路：「亮一点再去掉路人」')
    const cParams0 = await params()
    const cColors0 = await colors()
    await say('亮一点再去掉路人')
    const dCMask = await waitData(page, x => x.generating === true, 6000)
    const cParamsDuring = await params()
    const cColorsDuring = await colors()
    check('C1 蒙层**期间**参数已经落地（contrast 8→28），不是等生成完才套',
      dCMask.generating === true && cParamsDuring.contrast === cParams0.contrast + 20,
      'contrast: ' + cParams0.contrast + ' → ' + cParamsDuring.contrast)
    check('C2 蒙层期间画面已经按新参数画过（采样点变了）', cColorsDuring.first !== cColors0.first,
      cColors0.first + ' → ' + cColorsDuring.first)
    await shot(mp, 'say-C-mask')
    const dCdone = await waitData(page, x => x.generating === false && x.photoW === mockW, 9000)
    check('C3 生成完换图 + 撤销', dCdone.photoW === mockW && dCdone.canUndo === true,
      'photoW=' + dCdone.photoW + ' canUndo=' + dCdone.canUndo)
    const dCBubble = await waitData(page, x => x.sayBubble !== '', 4000)
    check('C4 浮条是 both 那句原文', dCBubble.sayBubble === '好，先加深一点对比，再把路人去掉。',
      JSON.stringify(dCBubble.sayBubble))
    const undoBtnC = await rpc(page.$('.undo-btn'), '$ .undo-btn')
    await rpc(undoBtnC.tap(), 'tap 撤销')
    const dCUndo = await waitData(page, x => x.canUndo === false && x.photo === photo0, 6000)
    const cParamsAfter = await params()
    check('C5 撤销把**参数和底图一起**还原回发前（一层）',
      dCUndo.photo === photo0 && JSON.stringify(cParamsAfter) === JSON.stringify(cParams0),
      'photo 归位=' + (dCUndo.photo === photo0) + ' params 归位=' + (JSON.stringify(cParamsAfter) === JSON.stringify(cParams0)))

    // ── [D] degraded：「随便修一下」→ 浮条拼上"拿不太准"提醒 ──────────────────
    log('\n[D] degraded 路：「随便修一下」')
    await say('随便修一下')
    const dD = await waitData(page, x => x.sayBubble.indexOf('拿不太准') >= 0, 9000)
    check('D1 浮条 = 原文 + 电脑版那句提醒（一字不差）',
      dD.sayBubble === '好，我大概懂了。这次我拿不太准，不对的话换个说法再试试。',
      JSON.stringify(dD.sayBubble))
    check('D2 degraded 走的还是生成（图真换了、撤销亮了）',
      dD.photoW === mockW && dD.canUndo === true && dD.generating === false,
      'photoW=' + dD.photoW + ' canUndo=' + dD.canUndo)

    // ── [E] 拿不准：「把那个人去掉」→ 参数照收、生成拦住 ─────────────────────
    log('\n[E] 拿不准路：「把那个人去掉」')
    const eBefore = await rpc(page.data(), 'page.data')
    const eParams0 = await params()
    await say('把那个人去掉')
    const dE = await waitData(page, x => x.sayBubble.indexOf('我不太确定') >= 0, 8000)
    check('E1 浮条 = 原文 + 「换个说法」那条（没有"点一下"—— 小程序没有那条路）',
      dE.sayBubble === '好，我在照片里没找到很明确的那一处。我不太确定你指的是哪个 —— 换个说法再试试。',
      JSON.stringify(dE.sayBubble))
    const eParams1 = await params()
    check('E2 参数那半照收（exposure 16→22，增量 +6）', eParams1.exposure === eParams0.exposure + 6,
      'exposure: ' + eParams0.exposure + ' → ' + eParams1.exposure)
    // ⚠️ canUndo 此刻是 true（上一场景 D 的生成留下的）—— 这里断言的是"**没被动过**"
    // （这一路不生成，也就不该动撤销），不是 false。
    check('E3 生成被拦住了：没蒙层、忙态已收、撤销没被动过',
      dE.generating === false && dE.sayBusy === false && dE.canUndo === eBefore.canUndo,
      'generating=' + dE.generating + ' canUndo=' + dE.canUndo + '（前值 ' + eBefore.canUndo + '）')
    await shot(mp, 'say-E-disambig')

    // ── [F] 停止 + 秒表换挡：「把路人去掉」（mock 延时改成 20 秒）─────────────
    log('\n[F] 停止 + 秒表：把 mock 的生成延时改成 ' + (EDIT_MS_LONG / 1000) + ' 秒（慢响应）')
    await getJson('/mock/set?editMs=' + EDIT_MS_LONG)
    const fBefore = await rpc(page.data(), 'page.data')
    const fParams0 = await params()
    const fColors0 = await colors()
    const statsBefore = await getJson('/mock/stats')
    await say('把路人去掉')
    const dF1 = await waitData(page, x => x.generating === true, 6000)
    check('F1 秒表开头「正在修…」不带数字', dF1.generating === true && !/[0-9]/.test(dF1.genText),
      'genText=' + JSON.stringify(dF1.genText))
    const dF2 = await waitData(page, x => x.genText.indexOf('已经等了') >= 0, 9000)
    check('F2 过了 5 秒换成真实秒数「正在修…已经等了 N 秒」',
      dF2.genText === '正在修…已经等了 ' + dF2.genSeconds + ' 秒' && dF2.genSeconds >= 5,
      'genText=' + JSON.stringify(dF2.genText) + ' genSeconds=' + dF2.genSeconds)
    await shot(mp, 'say-F-seconds')
    const stopBtn = await rpc(page.$('.gen-stop'), '$ .gen-stop')
    if (!stopBtn) throw new Error('蒙层上找不到「停止」（.gen-stop）')
    await rpc(stopBtn.tap(), 'tap 停止')
    const dF3 = await waitData(page, x => x.generating === false, 6000)
    check('F3 停止：蒙层收掉、浮条「停了。」', dF3.generating === false && dF3.sayBusy === false,
      'generating=' + dF3.generating + ' busy=' + dF3.sayBusy)
    const dFb = await waitData(page, x => x.sayBubble === '停了。', 4000)
    check('F4 浮条就是「停了。」（不说"没修成功"—— 是人叫停的）', dFb.sayBubble === '停了。',
      JSON.stringify(dFb.sayBubble))
    const fParams1 = await params()
    const fColors1 = await colors()
    check('F5 停止不动画面、不动参数、不动撤销',
      dFb.photo === fBefore.photo && dFb.photoW === fBefore.photoW &&
      JSON.stringify(fParams1) === JSON.stringify(fParams0) &&
      fColors1.first === fColors0.first && dFb.canUndo === fBefore.canUndo,
      'photo 同=' + (dFb.photo === fBefore.photo) + ' canUndo=' + dFb.canUndo)
    await shot(mp, 'say-F-stopped')
    // 服务端证据：那次 edit 是**真的被掐断**（不是只把界面关了）—— mock 的
    // editAborted 计数 +1（它的 res.on('close') 认的是连接断，不是界面状态）。
    const statsAfter = await getJson('/mock/stats')
    check('F6 服务端证据：mock 记到一次掐断（editAborted+1）',
      statsAfter.editAborted >= statsBefore.editAborted + 1,
      'editAborted ' + statsBefore.editAborted + ' → ' + statsAfter.editAborted)
    log('  mock stats：', JSON.stringify(statsAfter))

    // ── 收尾 ─────────────────────────────────────────────────────────────────
    await shot(mp, results.some(r => !r.ok) ? 'smoke-say-fail' : 'smoke-say-ok')
  } catch (e) {
    log('\n✖ 冒烟中途断了：' + (e && e.message ? e.message : e))
    if (mp && page) await shot(mp, 'smoke-say-fail')
    throw e
  } finally {
    // 收尾三件事都要尽最大努力做（每一步失败只记一笔，别盖住真正的错）——
    // 尤其 **API 地址必须指回 config**：它是运行期的全局开关，留着就把模拟器
    // 之后的一切请求都打到 mock 上（症状只有"连不上"，很难查）。
    try { if (page) await rpc(page.callMethod('__probeSetApiBase', ''), 'reset api base', 8000) } catch (e) { log('  [warn] API 地址没能指回 config：', e && e.message) }
    try { if (mp) await rpc(mp.disconnect(), 'disconnect', 10000) } catch (e) { /* 没连上也就算了 */ }
    if (mockProc) mockProc.kill()
  }

  const fail = results.filter(r => !r.ok)
  log('\n══════ 汇总：' + (results.length - fail.length) + '/' + results.length + ' 过 ══════')
  if (fail.length) {
    fail.forEach(f => log('  ❌ ' + f.name))
    log('（截图见 .superpowers/mini/smoke-say-*.png）')
    process.exit(1)
  }
  log('（截图都在 .superpowers/mini/say-*.png）')
  process.exit(0)
})().catch(e => {
  console.error('FATAL:', e && e.message ? e.message : e)
  process.exit(1)
})
