#!/usr/bin/env node
/**
 * 「说一句」全流程的冒烟（Task 12；**Task 14 起按「对话留痕」重写**）—— 对着**本地
 * mock 后端**（mock-server.cjs，4399）跑，真钱一分不花。和 smoke.cjs（全黑哨兵）
 * **分开两个文件**：那条链测的是"渲染出没出画"，这条测的是"一句话怎么分流、怎么等、
 * 怎么停、怎么撤，说过的话有没有留在屏幕上" —— 混在一个文件里，任何一边红了都看不出
 * 是哪条链断的，还互相拖时间。
 *
 * 前置（和 smoke.cjs 同款）：
 *   1) 微信开发者工具已用 CLI 起着（mini/README.md「冒烟」那节有命令）；
 *   2) mock 服务器**不用手动起** —— 脚本自己 spawn（4399 已有别人起着的就直接用，
 *      跑完也不杀它）；环境里 MOCK_ROUTE_MS=1200 / MOCK_EDIT_MS=800 是起它的参数。
 *
 * 故事线（六个场景，四种决策路 + 停止；断言全部读 `page.data().msgs` —— Task 14 起
 * 对话区取代了 5 秒浮条 + 照片蒙层）：
 *   A params   「亮一点」      —— 发送立刻留痕（我说的 + 在想的）→ 参数叠加 + 点亮
 *                                「通透提亮」+ reply 落进气泡；**再等 6 秒那条 reply 仍在**
 *                                （留痕本体 —— 浮条时代这里必然已淡出）
 *   B generate 「把路人去掉」   —— 气泡里转圈（秒数前 5 秒不带数字）→ 新图（尺寸换成
 *                                mock 那张）→ reply 落进气泡 + 撤销 → 点撤销 → 画面和
 *                                参数都回到发前 + **那次生成的两条对话一起收走**
 *   C both     「亮一点再去掉路人」—— 转圈**期间**就能读到参数已生效（contrast +20），
 *                                生成完 → 撤销把"参数+底图+对话"一起还原（一层）
 *   D degraded 「随便修一下」   —— 气泡里拼上"拿不太准"提醒（电脑版口径）
 *   E 拿不准   「把那个人去掉」 —— 参数照收（exposure +6）、生成拦住、没有转圈、
 *                                撤销没被动过
 *   F 停止     改 mock 延时到 20s —— 秒表 5 秒内不带数字、5 秒后「已经等了 N 秒」；
 *                                点**气泡里**的「停止」→ 请求真掐断（mock 的
 *                                editAborted 计数为证）、画面/参数/撤销原样、气泡「停了。」
 *   G 补充（Task 14 新增的两条）点一格风格 → 留一条系统小字；换一张 → 对话流清空、
 *                                重载一张仍空。
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
/** 整条冒烟的保险丝（七个场景正常 2~4 分钟；只是兜底，防"某个 await 没被套上"）。 */
const WATCHDOG_MS = 420000
/** 路由阶段的 mock 延时 —— 调大到 1200ms 才看得见「在想…」（真后端 1.3~1.6s 同量级） */
const ROUTE_MS = 1200
/** A~E 场景的生成延时（短，跑得快） */
const EDIT_MS = 800
/** F（停止 + 秒表）的生成延时 —— 要长到"5 秒换挡看到秒数、截图、再点停止"都在窗口里
 *  （截图慢的时候能吃掉好几秒，14s 曾差点不够，留 20s 的余量） */
const EDIT_MS_LONG = 20000
/** 「留痕本体」要等的时长（毫秒）——**必须大于旧浮条的 5 秒**：浮条时代等这么久
 *  那条回复必然已经淡出，现在它得还在。 */
const KEEP_MS = 6500

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

/** 对话流（msgs）的小工具：最后一条 / 条数。 */
const lastMsg = d => (d && d.msgs && d.msgs.length ? d.msgs[d.msgs.length - 1] : null)
const msgCount = d => (d && d.msgs ? d.msgs.length : -1)
const doneText = d => { const m = lastMsg(d); return m && m.kind === 'ai' && m.state === 'done' ? m.text : '' }

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
    check('前置：渲染 + 风格栏就绪 + 对话流是空的（说一句的起点）', ready && d.msgs.length === 0,
      'photoW×H=' + d.photoW + '×' + d.photoH + ' styles=' + d.styles.length + ' msgs=' + d.msgs.length)
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

    // ── [A] params：「亮一点」→ 先留痕 → 参数叠加 + 点亮 + reply 落进气泡 ───────
    log('\n[A] params 路：「亮一点」')
    const aColors0 = await colors()
    await say('亮一点')
    const dR = await waitData(page, x => x.sayBusy === true, 2500)
    check('A1 发送后输入条进「在想…」，照片上不弹任何东西（不弹蒙层）',
      dR.sayBusy === true && dR.sayBusyText === '在想…' && dR.generating === false,
      'busy=' + dR.sayBusy + ' text=' + dR.sayBusyText + ' generating=' + dR.generating)
    // ★ Task 14 留痕：**发送那一刻**就上屏两条（我说的 + 小皇帝在想的）
    const dPush = await waitData(page, x => x.msgs.length >= 2, 4000)
    const m0 = dPush.msgs[0]
    const m1 = dPush.msgs[1]
    check('A2 发送立刻留痕：一条「我说的」（原文）+ 一条「小皇帝在想的」',
      dPush.msgs.length === 2 && m0.kind === 'me' && m0.text === '亮一点' &&
      m1.kind === 'ai' && m1.state === 'thinking',
      JSON.stringify(dPush.msgs))
    const dA = await waitData(page, x => x.activeStyle === 'bright', 8000)
    // 点亮「通透提亮」= 15 个参数**全等**那套预设（共享 activePresetId 的判据），
    // 一句话把这个决策的参数半证死。
    check('A3 参数叠加生效：点亮「通透提亮」(bright)', dA.activeStyle === 'bright',
      'activeStyle=' + dA.activeStyle)
    const aParams = await params()
    check('A4 参数真的是增量叠出来的（exposure=16、saturation=6）',
      aParams.exposure === 16 && aParams.saturation === 6,
      'exposure=' + aParams.exposure + ' saturation=' + aParams.saturation)
    const aColors1 = await colors()
    check('A5 画面真的变了（采样点变了）', aColors1.first !== aColors0.first,
      aColors0.first + ' → ' + aColors1.first)
    // ★ Task 14：reply 落进**那颗气泡**（state 从 thinking 翻成 done）
    const dDone = await waitData(page, x => doneText(x) !== '', 6000)
    check('A6 模型那句 reply 落进对话区那颗气泡（state done、原文一字不差）',
      doneText(dDone) === '好，我把照片调成了通透提亮的样子。', JSON.stringify(doneText(dDone)))
    check('A7 参数路那一刻也没有别的过程元素（generating=false）', dDone.generating === false,
      'generating=' + dDone.generating)
    await shot(mp, 'say-A-qa') // ← 证据①：一问一答留在屏上
    // ★ 留痕本体（Task 14 的核心）：等 6.5 秒（> 旧浮条的 5 秒）再看，那两条仍在。
    const aCount = msgCount(dDone)
    await sleep(KEEP_MS)
    const dStill = await rpc(page.data(), 'page.data')
    check('A8 留痕本体：' + (KEEP_MS / 1000) + ' 秒后两条问答仍在屏上（浮条时代这里必然已淡出）',
      msgCount(dStill) === aCount &&
      dStill.msgs.some(m => m.kind === 'ai' && m.state === 'done' && m.text === '好，我把照片调成了通透提亮的样子。') &&
      !('sayBubble' in dStill),
      'msgs=' + msgCount(dStill) + '，旧浮条字段已退役=' + !('sayBubble' in dStill))

    // ── [B] generate：「把路人去掉」→ 气泡转圈 → 新图 → 撤销（连对话一起收）──────
    log('\n[B] generate 路：「把路人去掉」')
    const bColors0 = await colors()
    const bParams0 = await params()
    const bMsgsBefore = (await rpc(page.data(), 'page.data')).msgs
    await say('把路人去掉')
    const dMask = await waitData(page, x => x.generating === true, 8000)
    check('B1 进生成：那颗 AI 气泡在转（state thinking）、秒表开头不带数字（5 秒内不显示秒数）',
      dMask.generating === true && dMask.genText === '正在修…' && !/[0-9]/.test(dMask.genText) &&
      lastMsg(dMask) && lastMsg(dMask).kind === 'ai' && lastMsg(dMask).state === 'thinking',
      'genText=' + JSON.stringify(dMask.genText) + ' 末条=' + JSON.stringify(lastMsg(dMask)))
    check('B2 生成期间输入条是「正在修…」', dMask.sayBusy === true && dMask.sayBusyText === '正在修…',
      'busyText=' + dMask.sayBusyText)
    // ★ Task 14：「停止」搬进气泡了 —— 输入条那行再没有它，气泡里有
    const oldStop = await rpc(page.$('.say-act-stop'), '$ .say-act-stop')
    const bubbleStop = await rpc(page.$('.msg-stop'), '$ .msg-stop')
    check('B3 「停止」在气泡里（.msg-stop 在、输入条那行的 .say-act-stop 已退役）',
      oldStop === null && !!bubbleStop,
      'say-act-stop=' + (oldStop === null ? '无' : '还在') + ' msg-stop=' + (bubbleStop ? '有' : '无'))
    await shot(mp, 'say-B-thinking')
    const dBdone = await waitData(page, x => x.generating === false && x.canUndo === true, 9000)
    check('B4 生成完直接换图（尺寸换成 mock 那张）',
      dBdone.photoW === mockW && dBdone.photoH === mockH,
      'photoW×H=' + dBdone.photoW + '×' + dBdone.photoH + '（mock 那张 ' + mockW + '×' + mockH + '）')
    check('B5 输入条那行「撤销」亮了', dBdone.canUndo === true, 'canUndo=' + dBdone.canUndo)
    const dReply = await waitData(page, x => doneText(x) !== '', 4000)
    check('B6 reply 和图片一起落进对话区（原文，不自动消失）',
      doneText(dReply) === '好，这就把背景里的路人去掉。', JSON.stringify(doneText(dReply)))
    const bColors1 = await colors()
    check('B7 新图的像素真的不一样', bColors1.first !== bColors0.first, bColors0.first + ' → ' + bColors1.first)
    await shot(mp, 'say-B-done')
    // 点撤销（2026-10-13 真机修复后它在输入条那行：.say-act-undo）
    const undoBtn = await rpc(page.$('.say-act-undo'), '$ .say-act-undo')
    if (!undoBtn) throw new Error('找不到「撤销」（.say-act-undo）')
    await rpc(undoBtn.tap(), 'tap 撤销')
    const dUndo = await waitData(page,
      x => x.canUndo === false && x.photo === photo0 && msgCount(x) === bMsgsBefore.length, 8000)
    check('B8 撤销：底图回到发前那张', dUndo.photo === photo0 && dUndo.photoW === photoW0,
      'photo=' + dUndo.photo)
    const bParams1 = await params()
    check('B9 撤销：参数也回到发前', JSON.stringify(bParams1) === JSON.stringify(bParams0),
      JSON.stringify(bParams1) === JSON.stringify(bParams0) ? '' : JSON.stringify(bParams1))
    const bColors2 = await colors()
    check('B10 撤销后采样点 + 色数还原（16×16 网格：首采样点、颜色数双双相同）',
      bColors2.first === bColors0.first && bColors2.colors === bColors0.colors,
      bColors0.first + '/' + bColors0.colors + '色 vs ' + bColors2.first + '/' + bColors2.colors + '色')
    // ★ Task 14：那次生成的两条（我说的 + 回复）**一起收走**，更早的留着
    check('B11 撤销把那次生成的两条对话一起收走（更早的还在）',
      msgCount(dUndo) === bMsgsBefore.length &&
      JSON.stringify(dUndo.msgs.map(m => m.text)) === JSON.stringify(bMsgsBefore.map(m => m.text)),
      '撤销后 ' + msgCount(dUndo) + ' 条：' + JSON.stringify(dUndo.msgs.map(m => m.kind + ':' + m.text)))
    check('B12 撤销完按钮收掉（一层）', dUndo.canUndo === false, 'canUndo=' + dUndo.canUndo)
    await shot(mp, 'say-B-undone')

    // ── [C] both：「亮一点再去掉路人」→ 参数先落地（转圈期间就能读到）→ 一起撤销 ──
    log('\n[C] both 路：「亮一点再去掉路人」')
    const cParams0 = await params()
    const cColors0 = await colors()
    const cMsgsBefore = (await rpc(page.data(), 'page.data')).msgs
    await say('亮一点再去掉路人')
    const dCGen = await waitData(page, x => x.generating === true, 8000)
    const cParamsDuring = await params()
    const cColorsDuring = await colors()
    check('C1 转圈**期间**参数已经落地（contrast 8→28），不是等生成完才套',
      dCGen.generating === true && cParamsDuring.contrast === cParams0.contrast + 20,
      'contrast: ' + cParams0.contrast + ' → ' + cParamsDuring.contrast)
    check('C2 转圈期间画面已经按新参数画过（采样点变了）', cColorsDuring.first !== cColors0.first,
      cColors0.first + ' → ' + cColorsDuring.first)
    await shot(mp, 'say-C-thinking')
    const dCdone = await waitData(page, x => x.generating === false && x.photoW === mockW, 9000)
    check('C3 生成完换图 + 撤销', dCdone.photoW === mockW && dCdone.canUndo === true,
      'photoW=' + dCdone.photoW + ' canUndo=' + dCdone.canUndo)
    const dCReply = await waitData(page, x => doneText(x) !== '', 4000)
    check('C4 对话区那颗气泡是 both 那句原文',
      doneText(dCReply) === '好，先加深一点对比，再把路人去掉。', JSON.stringify(doneText(dCReply)))
    const undoBtnC = await rpc(page.$('.say-act-undo'), '$ .say-act-undo')
    if (!undoBtnC) throw new Error('both 场景找不到「撤销」（.say-act-undo）')
    await rpc(undoBtnC.tap(), 'tap 撤销')
    const dCUndo = await waitData(page,
      x => x.canUndo === false && x.photo === photo0 && msgCount(x) === cMsgsBefore.length, 8000)
    const cParamsAfter = await params()
    check('C5 撤销把**参数和底图一起**还原回发前（一层）',
      dCUndo.photo === photo0 && JSON.stringify(cParamsAfter) === JSON.stringify(cParams0),
      'photo 归位=' + (dCUndo.photo === photo0) + ' params 归位=' + (JSON.stringify(cParamsAfter) === JSON.stringify(cParams0)))
    check('C6 撤销把 both 那次的两条也一起收走',
      msgCount(dCUndo) === cMsgsBefore.length &&
      JSON.stringify(dCUndo.msgs.map(m => m.text)) === JSON.stringify(cMsgsBefore.map(m => m.text)),
      '撤销后 ' + msgCount(dCUndo) + ' 条')

    // ── [D] degraded：「随便修一下」→ 气泡里拼上"拿不太准"提醒 ─────────────────
    log('\n[D] degraded 路：「随便修一下」')
    await say('随便修一下')
    const dD = await waitData(page, x => doneText(x).indexOf('拿不太准') >= 0, 9000)
    check('D1 气泡 = 原文 + 电脑版那句提醒（一字不差）',
      doneText(dD) === '好，我大概懂了。这次我拿不太准，不对的话换个说法再试试。',
      JSON.stringify(doneText(dD)))
    check('D2 degraded 走的还是生成（图真换了、撤销亮了）',
      dD.photoW === mockW && dD.canUndo === true && dD.generating === false,
      'photoW=' + dD.photoW + ' canUndo=' + dD.canUndo)

    // ── [E] 拿不准：「把那个人去掉」→ 参数照收、生成拦住 ─────────────────────
    log('\n[E] 拿不准路：「把那个人去掉」')
    const eBefore = await rpc(page.data(), 'page.data')
    const eParams0 = await params()
    await say('把那个人去掉')
    const dE = await waitData(page, x => doneText(x).indexOf('我不太确定') >= 0, 9000)
    check('E1 气泡 = 原文 + 「换个说法」那条（没有"点一下"—— 小程序没有那条路）',
      doneText(dE) === '好，我在照片里没找到很明确的那一处。我不太确定你指的是哪个 —— 换个说法再试试。',
      JSON.stringify(doneText(dE)))
    const eParams1 = await params()
    check('E2 参数那半照收（exposure 16→22，增量 +6）', eParams1.exposure === eParams0.exposure + 6,
      'exposure: ' + eParams0.exposure + ' → ' + eParams1.exposure)
    // ⚠️ canUndo 此刻是 true（上一场景 D 的生成留下的）—— 这里断言的是"**没被动过**"
    // （这一路不生成，也就不该动撤销），不是 false。
    check('E3 生成被拦住了：没转圈、忙态已收、撤销没被动过',
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
    const dF1 = await waitData(page, x => x.generating === true, 8000)
    check('F1 秒表开头「正在修…」不带数字（那颗气泡仍在转）',
      dF1.generating === true && !/[0-9]/.test(dF1.genText) &&
      lastMsg(dF1) && lastMsg(dF1).kind === 'ai' && lastMsg(dF1).state === 'thinking',
      'genText=' + JSON.stringify(dF1.genText))
    const dF2 = await waitData(page, x => x.genText.indexOf('已经等了') >= 0, 12000)
    check('F2 过了 5 秒换成真实秒数「正在修…已经等了 N 秒」',
      dF2.genText === '正在修…已经等了 ' + dF2.genSeconds + ' 秒' && dF2.genSeconds >= 5,
      'genText=' + JSON.stringify(dF2.genText) + ' genSeconds=' + dF2.genSeconds)
    check('F3 秒数就写在那颗 thinking 气泡里（生成中它没被顶掉 / 没消失）',
      lastMsg(dF2) && lastMsg(dF2).kind === 'ai' && lastMsg(dF2).state === 'thinking',
      JSON.stringify(lastMsg(dF2)))
    await shot(mp, 'say-F-seconds') // ← 证据②：转圈 + 秒数 + 停止 三样都在气泡里
    const stopBtn = await rpc(page.$('.msg-stop'), '$ .msg-stop')
    if (!stopBtn) throw new Error('气泡里找不到「停止」（.msg-stop）')
    await rpc(stopBtn.tap(), 'tap 停止')
    const dF3 = await waitData(page, x => x.generating === false, 8000)
    check('F4 停止：转圈收掉、忙态收', dF3.generating === false && dF3.sayBusy === false,
      'generating=' + dF3.generating + ' busy=' + dF3.sayBusy)
    const dFStop = await waitData(page, x => lastMsg(x) && lastMsg(x).state === 'stopped', 4000)
    check('F5 那颗气泡落「停了。」（state stopped；不说"没修成功"—— 是人叫停的）',
      lastMsg(dFStop) && lastMsg(dFStop).text === '停了。', JSON.stringify(lastMsg(dFStop)))
    const fParams1 = await params()
    const fColors1 = await colors()
    check('F6 停止不动画面、不动参数、不动撤销',
      dFStop.photo === fBefore.photo && dFStop.photoW === fBefore.photoW &&
      JSON.stringify(fParams1) === JSON.stringify(fParams0) &&
      fColors1.first === fColors0.first && dFStop.canUndo === fBefore.canUndo,
      'photo 同=' + (dFStop.photo === fBefore.photo) + ' canUndo=' + dFStop.canUndo)
    await shot(mp, 'say-F-stopped')
    // 服务端证据：那次 edit 是**真的被掐断**（不是只把界面关了）—— mock 的
    // editAborted 计数 +1（它的 res.on('close') 认的是连接断，不是界面状态）。
    const statsAfter = await getJson('/mock/stats')
    check('F7 服务端证据：mock 记到一次掐断（editAborted+1）',
      statsAfter.editAborted >= statsBefore.editAborted + 1,
      'editAborted ' + statsBefore.editAborted + ' → ' + statsAfter.editAborted)
    log('  mock stats：', JSON.stringify(statsAfter))

    // ── [F·量] 空间感：对话区封顶时盒子多高、照片区还剩多少（写进报告的 px）──────
    //   （这里对话流已经攒了 8 条 —— A/D/E 各一对 + F 这一对 —— 足够超过封顶）
    const msgsEl = await rpc(page.$('.msgs'), '$ .msgs')
    const stageEl = await rpc(page.$('#stage-area'), '$ #stage-area')
    const win = await rpc(mp.evaluate(() => {
      const i = wx.getWindowInfo()
      return { w: i.windowWidth, h: i.windowHeight }
    }), 'windowInfo')
    if (msgsEl && stageEl) {
      const box = await rpc(msgsEl.size(), 'msgs.size')
      const sbox = await rpc(stageEl.size(), 'stage-area.size')
      const capPx = 400 * win.w / 750 // 400rpx 在这个窗口宽下等于多少 px
      log('  [量] 对话区 ' + msgCount(dFStop) + ' 条时：.msgs 盒子 ' +
        box.width + '×' + box.height + 'px（封顶 ' + capPx.toFixed(1) + 'px）；' +
        '#stage-area 剩余 ' + sbox.width + '×' + sbox.height + 'px；屏 ' + win.w + '×' + win.h)
      check('F8 对话区封顶生效（max-height 400rpx 真的夹住了 —— 内容再多也不长）',
        Number(box.height) <= capPx + 2, '盒子高 ' + box.height + 'px ≤ ' + capPx.toFixed(1) + 'px')
    } else {
      check('F8 对话区封顶生效（max-height 400rpx 真的夹住了）', false, '量不到 .msgs / #stage-area 的盒子')
    }

    // ── [G] Task 14 补充：点风格留一行系统小字；换照片把对话流清空 ─────────────
    log('\n[G] 系统小字 + 换照片清空（Task 14 新增的两条）')
    const gBefore = await rpc(page.data(), 'page.data')
    const cells = await rpc(page.$$('.style-cell'), '$$ .style-cell')
    const cell1 = cells && cells.length > 1 ? cells[1] : null
    if (!cell1) throw new Error('找不到第 2 格风格（.style-cell，13 格应已就绪）')
    const label1 = gBefore.styles[1].label // 第 2 格 = 第一个预设「日系通透」
    await rpc(cell1.tap(), 'tap style[1]')
    const dG1 = await waitData(page, x => lastMsg(x) && lastMsg(x).kind === 'note', 5000)
    check('G1 点一格风格 → 对话区连一条系统小字「套用了「…」」',
      lastMsg(dG1) && lastMsg(dG1).kind === 'note' && lastMsg(dG1).text === '套用了「' + label1 + '」',
      JSON.stringify(lastMsg(dG1)) + '（期望 label：' + label1 + '）')
    check('G2 点风格不动撤销（canUndo 一个字没变 —— 它不进撤销）',
      dG1.canUndo === gBefore.canUndo, 'canUndo=' + dG1.canUndo + '（前值 ' + gBefore.canUndo + '）')
    // 换一张 → 回空态：对话流应当清空
    const backBtn = await rpc(page.$('.tb-left'), '$ .tb-left')
    await rpc(backBtn.tap(), 'tap 换一张')
    const dG3 = await waitData(page, x => x.stage === 'empty', 8000)
    check('G3 换一张 → 回空态、对话流清空', dG3.stage === 'empty' && dG3.msgs.length === 0,
      'stage=' + dG3.stage + ' msgs=' + dG3.msgs.length)
    // 再载入一张（applyPickedPhoto 那条清空线）：也不许把上一张的话带回来
    const devBtn2 = await rpc(page.$('.dev-btn'), '$ .dev-btn')
    await rpc(devBtn2.tap(), 'tap dev（再次载入）')
    const dG4 = await waitData(page, x => x.stage === 'edit' && x.styles.length === 13, 60000)
    check('G4 重新载入一张：对话流还是空的（applyPickedPhoto 的清理生效）',
      dG4.msgs.length === 0 && dG4.stage === 'edit', 'stage=' + dG4.stage + ' msgs=' + dG4.msgs.length)
    await shot(mp, 'say-G-reloaded')

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
    // 顺带把 mock 的生成延时改回短的（复用别人起着的 mock 时别把 20 秒留给下一趟）。
    try { await getJson('/mock/set?editMs=' + EDIT_MS) } catch (e) { /* mock 没了也就算了 */ }
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
