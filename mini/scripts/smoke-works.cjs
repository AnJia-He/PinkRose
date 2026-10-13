#!/usr/bin/env node
/**
 * 「作品」页全流程冒烟（Task 17）—— 保存顺带写作品 → 相册墙看到 → 长按删。
 * **不花钱**：不起 mock 后端（全程零网络请求），保存那一点用页面上的
 * `__probeSaveWork()`（真跑一遍导出 + 收进本地作品集，**不碰相册**）。
 *
 * 前置（和别的冒烟同款）：微信开发者工具已用 CLI 起着（mini/README.md「冒烟」那节）。
 *
 * 故事线（断言大多读：作品页 `page.data().items`、storage 清单、devtools 侧
 * `wx.getFileSystemManager()` 的文件事实）：
 *   [0] 镜像守卫（sync --check）→ [1] 连 9420 → 回到修图页
 *   [2] 清场：删 works 目录 + 清单 storage（确定性：不赌上一趟留下的东西）
 *   [3] 空态：切作品 tab → items 0、空态文案在、没有格子、有「去修一张」（截图）
 *   [4] 修图页载入测试照片（dev 通道）→ 调 `__probeSaveWork()`（发起 + 轮询实例字段
 *       `probeSaveWork` —— 长任务不等 callMethod）
 *   [5] 落盘事实：清单 +1、字段齐、宽高 = 照片实测、两个文件都在且缩略图真缩过
 *       （长边 ≤256，getImageInfo 量的）、目录里恰好两个文件
 *   [6] 回作品页：网格 1 格、格子是正方（两列量级）、点格 → previewImage 收到
 *       全部全尺寸路径 + current 是这张（mock 记的账）、截图；再塞第 2 条夹具量
 *       两列（两格 top 相等 / left 不同）→ 清夹具（T18 复审 M4）
 *   [7] 「我的」页：1 张 → 数值行对得上（页面 data 对清单现算）、截图、点「清空」
 *       （mock showModal 自动确认）→ 清单 / 目录 / 数字全归零 + 0 张置灰标记（截图）
 *   [8] 重存一张（[7] 清掉后给长按删当靶子）→ 长按删：清单 0、两个文件都没了、
 *       空态回来了（截图）
 *   [9] cap 满了：往清单灌一条「快满」的夹具（别真存 150MB）→ add 拒绝、文案就是
 *       那条专属 toast 的原话、目录里没被写半张
 *   [10] 清单写失败（mock setStorageSync 抛一次）：add 拒绝 + 人话文案、刚 copy 的
 *        孤儿文件被清掉、清单没留半条（T18 复审 M2 的靶子）
 *   [11] 收尾：还原 mock、回修图页
 *
 * ⚠️ 防挂死纪律（和 smoke.cjs / smoke-say.cjs 同款）：每个 automator 调用套 rpc()
 *    上限、每处轮询有上限、整条有看门狗。截图是**证据不是判据**。
 *
 * 用法（CLI 已起着）：node mini/scripts/smoke-works.cjs
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..', '..') // 仓库根（同步脚本在它下面）
const OUT = path.join(ROOT, '.superpowers', 'mini') // 截图落这（和别的探针同处）
const ENDPOINT = process.env.WS ?? 'ws://127.0.0.1:9420'
/** 清单的 storage key —— 必须和 mini/lib/works.ts 的 `KEY` 一致（那边改了这跟着改）。 */
const WORKS_KEY = 'works:v1'
const RPC_MS = 30000
/** 整条冒烟的保险丝（正常 1.5~2 分钟；Task 18 加了「我的」段 + 一张重存——
 *  截图偶发 30s 超时最多吃两回，余量给够；防"某个 await 没被套上"，防挂死）。 */
const WATCHDOG_MS = 300000

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

/** 轮询 page.data() 直到满足，超时把最后一拍还回去（断言那边自己判）。 */
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

let mp = null
let page = null
/** 已经挂上的 mock（看门狗/收尾要还原它们；见 `restoreMocks`）。 */
const mocked = []
async function restoreMocks() {
  for (const name of mocked) {
    try { await rpc(mp.restoreWxMethod(name), 'restore ' + name, 8000) } catch (e) { /* 会话半死就别挣扎了 */ }
  }
  mocked.length = 0
}

/** showModal 的 mock：自动确认（**既回调、又返回结果对象** —— 铁律；记账给断言读）。
 *  幂等：两处（我的页清空 / 作品页长按删）共用，别重复挂。 */
async function ensureModalMock() {
  if (mocked.includes('showModal')) return
  await rpc(mp.mockWxMethod('showModal', function (opt) {
    globalThis.__modalCalls = (globalThis.__modalCalls || 0) + 1
    globalThis.__modalTitle = opt.title || ''
    const res = { confirm: true, cancel: false, errMsg: 'showModal:ok' }
    if (opt.success) opt.success(res)
    return res
  }), 'mock showModal')
  mocked.push('showModal')
}
/** 清掉弹框记账（每段开测前先归零）。 */
const resetModalLog = () => rpc(mp.evaluate(function () {
  globalThis.__modalCalls = 0
  globalThis.__modalTitle = ''
  return JSON.stringify(true)
}), 'clear modal log')

;(async () => {
  // 保险丝：整条超过上限直接退（码 2）—— 不傻等；先把 mock 还原了再退
  // （process.exit 会跳过 finally；mock 留着会影响后续冒烟）
  setTimeout(async () => {
    log('\n✖ 看门狗：整条冒烟超过 ' + (WATCHDOG_MS / 1000) + ' 秒还没跑完 —— 收尾后直接退（码 2）。')
    try { await restoreMocks() } catch (e) { /* 尽力而为 */ }
    process.exit(2)
  }, WATCHDOG_MS)

  // ── [0] 前置守卫：镜像漂了就别测（和别的冒烟同一条）─────────────────────
  log('[0] 前置守卫：node scripts/sync-mini-shared.mjs --check')
  const guard = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'sync-mini-shared.mjs'), '--check'], { stdio: 'inherit' })
  if (guard.status !== 0) {
    log('✖ 守卫没过（exit=' + guard.status + '）—— 镜像与源头不一致，先跑一遍同步再来测。')
    process.exit(1)
  }

  // ── [1] 连模拟器 → 回到修图页 ────────────────────────────────────────────
  log('\n[1] 连模拟器', ENDPOINT, '…')
  try {
    mp = await rpc(automator.connect({ wsEndpoint: ENDPOINT }), 'connect', 20000)
  } catch (e) {
    throw new Error('连不上 ' + ENDPOINT + ' —— CLI 起了吗？（mini/README.md「冒烟」那节）原始错误：' + (e && e.message ? e.message : e))
  }
  mp.on('console', m => log('   [mini console]', typeof m === 'object' ? JSON.stringify(m).slice(0, 400) : String(m).slice(0, 400)))
  mp.on('exception', e => log('   [mini exception]', JSON.stringify(e).slice(0, 600)))

  page = await rpc(mp.currentPage(), 'currentPage')
  log('[1] 当前页面:', page.path)
  if (page.path !== 'pages/index/index') {
    page = await rpc(mp.switchTab('/pages/index/index'), 'switchTab index')
    log('[1] 切回修图页：', page.path)
  }

  // devtools 侧读文件的三个小工具（都在页面运行时里量，回 bring JSON 字符串）
  const evalJson = (fn, ...args) => rpc(mp.evaluate(fn, ...args), 'evaluate').then(s => JSON.parse(String(s)))
  const readManifest = () => evalJson(function (key) {
    const v = wx.getStorageSync(key)
    return JSON.stringify(Array.isArray(v) ? v : [])
  }, WORKS_KEY)
  const fsStat = p => evalJson(function (fp) {
    try {
      const st = wx.getFileSystemManager().statSync(fp)
      return JSON.stringify({ ok: true, size: Array.isArray(st) ? 0 : st.size })
    } catch (e) {
      return JSON.stringify({ ok: false, err: (e && e.errMsg) || String(e) })
    }
  }, p)
  const imgSize = p => evalJson(function (fp) {
    return new Promise(function (res) {
      wx.getImageInfo({
        src: fp,
        success: r => res(JSON.stringify({ ok: true, w: r.width, h: r.height })),
        fail: e => res(JSON.stringify({ ok: false, err: (e && e.errMsg) || String(e) })),
      })
    })
  }, p)
  const dirList = () => evalJson(function () {
    try {
      return JSON.stringify(wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH + '/works'))
    } catch (e) {
      return JSON.stringify([])
    }
  })

  // ── [2] 清场：不赌上一趟留下的东西 ───────────────────────────────────────
  log('\n[2] 清场：删 works 目录 + 清单 storage')
  await rpc(mp.evaluate(function (key) {
    const fsm = wx.getFileSystemManager()
    try { fsm.rmdirSync(wx.env.USER_DATA_PATH + '/works', true) } catch (e) { /* 本来就没有 */ }
    try { wx.removeStorageSync(key) } catch (e) { /* 同上 */ }
    return JSON.stringify(true)
  }, WORKS_KEY), 'clean works')
  check('清场：清单为 0（起点是干净的）', (await readManifest()).length === 0)
  // 上一次跑完可能停在编辑态：先「换一张」回空态（dev 按钮在空态那张屏上）
  let d = await rpc(page.data(), 'page.data')
  if (d.stage === 'edit') {
    const back = await rpc(page.$('.tb-left'), '$ .tb-left')
    if (!back) throw new Error('停在编辑态却找不到「换一张」（.tb-left）')
    await rpc(back.tap(), 'tap 换一张')
    d = await waitData(page, x => x.stage === 'empty', 8000)
  }
  if (d.stage !== 'empty') throw new Error('回不到空态：stage=' + d.stage)

  // ── [3] 空态（作品页）────────────────────────────────────────────────────
  log('\n[3] 切作品页看空态')
  page = await rpc(mp.switchTab('/pages/works/works'), 'switchTab works')
  const dEmpty = await waitData(page, x => Array.isArray(x.items) && x.items.length === 0, 8000)
  check('空态①：items 为 0', Array.isArray(dEmpty.items) && dEmpty.items.length === 0, 'items=' + JSON.stringify(dEmpty.items))
  const emptyTitle = await rpc(page.$('.empty-title'), '$ .empty-title')
  const emptyText = emptyTitle ? await rpc(emptyTitle.text(), '.empty-title text()') : ''
  check('空态②：空态文案在（「还没有作品」）', emptyTitle !== null && emptyText.indexOf('还没有作品') >= 0, 'text=' + emptyText)
  check('空态③：网格没有格子', (await rpc(page.$('.cell'), '$ .cell')) === null)
  check('空态④：「去修一张」按钮在', (await rpc(page.$('.go-btn'), '$ .go-btn')) !== null)
  await shot(mp, 'works-empty')

  // ── [4] 修图页：载入测试照片 → __probeSaveWork（真导出，不碰相册）────────
  log('\n[4] 修图页载入测试照片 → __probeSaveWork')
  page = await rpc(mp.switchTab('/pages/index/index'), 'switchTab index')
  const devBtn = await rpc(page.$('.dev-btn'), '$ .dev-btn')
  if (!devBtn) throw new Error('页面上没有 dev 按钮（非开发版？或改过页面代码还没重编译 —— cli quit → 等端口消失 → agent start）')
  await rpc(devBtn.tap(), 'tap dev')
  d = await waitData(page, x => x.stage === 'edit' && x.styles.length === 13 && !!x.spritePath, 60000)
  const ready = d.stage === 'edit' && d.styles.length === 13 && !!d.spritePath
  check('前置：测试照片进编辑态 + 风格栏就绪', ready, 'photoW×H=' + d.photoW + '×' + d.photoH + ' styles=' + d.styles.length)
  if (!ready) {
    await shot(mp, 'smoke-works-fail')
    throw new Error('没进编辑态，后面的落盘断言没法跑')
  }

  // 发起 + 轮询实例字段（长任务不等 callMethod —— README 那条）
  await rpc(mp.evaluate(function () {
    const ps = getCurrentPages()
    const p = ps[ps.length - 1]
    p.probeSaveWork = null
    return JSON.stringify(true)
  }), 'clear probeSaveWork')
  page.callMethod('__probeSaveWork').catch(() => { /* 结果看字段，不看这个 promise */ })
  let probe = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      probe = await evalJson(function () {
        const ps = getCurrentPages()
        const p = ps[ps.length - 1]
        return JSON.stringify(p && p.probeSaveWork ? p.probeSaveWork : null)
      })
      if (probe && probe.state !== 'running') break
      await sleep(250)
    }
  }
  check('探针：__probeSaveWork 真导出 + 收进作品集（state=ok）', !!probe && probe.state === 'ok', JSON.stringify(probe))
  if (!probe || probe.state !== 'ok') {
    await shot(mp, 'smoke-works-fail')
    throw new Error('__probeSaveWork 没成功，后面的断言没法跑（why 见上）')
  }

  // ── [5] 落盘事实 ─────────────────────────────────────────────────────────
  log('\n[5] 落盘事实（清单 + 文件）')
  const man = await readManifest()
  check('落盘①：清单 +1', man.length === 1, 'len=' + man.length)
  if (man.length !== 1) {
    await shot(mp, 'smoke-works-fail')
    throw new Error('清单不是 1 条（' + man.length + '）—— 后面没法按条目断言')
  }
  const e0 = man[0]
  check('落盘②：条目字段齐（id/file/thumb/w/h/bytes/at）',
    !!(e0.id && e0.file && e0.thumb && e0.w > 0 && e0.h > 0 && e0.bytes > 0 && e0.at > 0),
    JSON.stringify({ id: e0.id, file: e0.file, thumb: e0.thumb, w: e0.w, h: e0.h, bytes: e0.bytes }))
  check('落盘③：宽高 = 照片实测尺寸（和页面对得上）', e0.w === d.photoW && e0.h === d.photoH,
    e0.w + '×' + e0.h + ' vs photo ' + d.photoW + '×' + d.photoH)
  const stFull = await fsStat(e0.file)
  check('落盘④：全尺寸文件在且非空', stFull.ok === true && stFull.size > 0, JSON.stringify(stFull))
  const stThumb = await fsStat(e0.thumb)
  check('落盘⑤：缩略图文件在且非空', stThumb.ok === true && stThumb.size > 0, JSON.stringify(stThumb))
  check('落盘⑥：缩略图明显小于全尺寸（真的缩过）', stFull.ok && stThumb.ok && stThumb.size < stFull.size,
    Math.round(stFull.size / 1024) + 'KB → ' + Math.round(stThumb.size / 1024) + 'KB')
  const tSize = await imgSize(e0.thumb)
  check('落盘⑦：缩略图长边 ≤256（getImageInfo 量的）', tSize.ok === true && Math.max(tSize.w, tSize.h) <= 256, JSON.stringify(tSize))
  const names = (await dirList()).slice().sort()
  const wantNames = [e0.file.split('/').pop(), e0.thumb.split('/').pop()].sort()
  check('落盘⑧：目录里恰好两个文件（w<id>.jpg + w<id>t.jpg）',
    names.length === 2 && names[0] === wantNames[0] && names[1] === wantNames[1],
    names.join(',') + ' vs ' + wantNames.join(','))

  // ── [6] 作品页：1 格 + 点格 previewImage ────────────────────────────────
  log('\n[6] 回作品页：网格 1 格 + 点格看大图')
  page = await rpc(mp.switchTab('/pages/works/works'), 'switchTab works')
  const dOne = await waitData(page, x => x.items.length === 1, 8000)
  check('相册墙①：网格 1 张（onShow 重新 list）', dOne.items.length === 1, 'len=' + dOne.items.length)
  check('相册墙②：缩略图 src 指向落盘的那张', dOne.items.length === 1 && dOne.items[0].thumb === e0.thumb,
    dOne.items.length ? 'thumb=' + dOne.items[0].thumb : '（没有条目）')
  const cell = await rpc(page.$('.cell'), '$ .cell')
  check('相册墙③：格子在（.cell 存在）', cell !== null)
  const rect = await rpc(evalJson(function () {
    // ⚠️ 链式 API 的返回值必须**接住再 exec**（task16 探针的教训）；结果从 exec 回调拿
    return new Promise(function (res) {
      const q = wx.createSelectorQuery()
      q.select('.cell').boundingClientRect()
      q.exec(function (r) {
        const x = r && r[0]
        res(JSON.stringify(x ? { width: x.width, height: x.height } : null))
      })
    })
  }), 'measure .cell')
  check('相册墙④：格子是正方、两列量级（宽≈高、约 173px 一列）',
    !!rect && Math.abs(rect.width - rect.height) < 1 && rect.width > 100 && rect.width < 250,
    rect ? rect.width.toFixed(1) + '×' + rect.height.toFixed(1) : 'null')
  await shot(mp, 'works-one')

  // 点格 → previewImage（mock 记账；**既回调又返回结果对象**那条铁律）
  await rpc(mp.mockWxMethod('previewImage', function (opt) {
    globalThis.__pvCalls = (globalThis.__pvCalls || 0) + 1
    globalThis.__pvUrls = (opt.urls || []).slice(0)
    globalThis.__pvCurrent = opt.current || ''
    const res = { errMsg: 'previewImage:ok' }
    if (opt.success) opt.success(res)
    return res
  }), 'mock previewImage')
  mocked.push('previewImage')
  await rpc(mp.evaluate(function () {
    globalThis.__pvCalls = 0
    globalThis.__pvUrls = []
    globalThis.__pvCurrent = ''
    return JSON.stringify(true)
  }), 'clear preview mock')
  const cellForTap = await rpc(page.$('.cell'), '$ .cell')
  await rpc(cellForTap.tap(), 'tap .cell')
  let pv = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      pv = await evalJson(function () {
        return JSON.stringify({
          calls: globalThis.__pvCalls || 0,
          urls: globalThis.__pvUrls || [],
          current: globalThis.__pvCurrent || '',
        })
      })
      if (pv.calls > 0) break
      await sleep(200)
    }
  }
  check('相册墙⑤：点格 → previewImage（全部全尺寸路径 + current 是这张）',
    !!pv && pv.calls === 1 && pv.urls.length === 1 && pv.urls[0] === e0.file && pv.current === e0.file,
    JSON.stringify(pv))

  // 两列布局：塞第 2 条夹具（file/thumb 就指现有那张 —— 只量版面，别真存第二张；
  // 照 [9] cap 段灌夹具的先例）→ 量两格 → 清夹具回到 1 格（T18 复审 M4）
  await rpc(mp.evaluate(function (payload) {
    const v = wx.getStorageSync(payload.key)
    const arr = Array.isArray(v) ? v : []
    arr.unshift({ id: 'grid-fixture', file: payload.file, thumb: payload.thumb, w: payload.w, h: payload.h, bytes: 1, at: 1 })
    wx.setStorageSync(payload.key, arr)
    return JSON.stringify(true)
  }, { key: WORKS_KEY, file: e0.file, thumb: e0.thumb, w: e0.w, h: e0.h }), 'inject grid fixture')
  await rpc(page.callMethod('refresh'), 'refresh works page')
  const dTwo = await waitData(page, x => x.items.length === 2, 8000)
  await sleep(300) // 等一帧版面（setData 落地到渲染层有缝）
  const rects2 = await rpc(evalJson(function () {
    return new Promise(function (res) {
      const q = wx.createSelectorQuery()
      q.selectAll('.cell').boundingClientRect()
      q.exec(function (r) {
        const cells = (r && r[0]) || []
        res(JSON.stringify(cells.map(x => ({ top: x.top, left: x.left }))))
      })
    })
  }), 'measure two cells')
  check('相册墙⑥：两列同排（两格 top 相等 ±1px、left 不同）',
    dTwo.items.length === 2 && Array.isArray(rects2) && rects2.length === 2 &&
      Math.abs(rects2[0].top - rects2[1].top) <= 1 &&
      Math.abs(rects2[0].left - rects2[1].left) > 50,
    JSON.stringify(rects2))
  await rpc(mp.evaluate(function (key) {
    const v = wx.getStorageSync(key)
    const arr = Array.isArray(v) ? v : []
    wx.setStorageSync(key, arr.filter(e => !e || e.id !== 'grid-fixture'))
    return JSON.stringify(true)
  }, WORKS_KEY), 'remove grid fixture')
  await rpc(page.callMethod('refresh'), 'refresh works page')
  const dBack = await waitData(page, x => x.items.length === 1, 8000)
  check('相册墙⑦：清掉夹具回到 1 格（别把版面证据留在清单里）', dBack.items.length === 1, 'len=' + dBack.items.length)

  // ── [7] 「我的」页：1 张 → 数字对账 → 清空（mock showModal 自动确认）────────
  log('\n[7] 「我的」页：1 张的数字 → 清空 → 0 张置灰')
  page = await rpc(mp.switchTab('/pages/me/me'), 'switchTab me')
  let dMe = await waitData(page, x => x.count === 1, 8000)
  check('我的①：数值行含「1 张」与「MB」',
    typeof dMe.usageText === 'string' && dMe.usageText.indexOf('1 张') >= 0 && dMe.usageText.indexOf('MB') >= 0,
    'usageText=' + dMe.usageText)
  const manMe = await readManifest()
  const usageNow = { count: manMe.length, bytes: manMe.reduce((s, e) => s + e.bytes, 0) }
  check('我的②：页面 data 与 usage() 一致（对清单现算）',
    dMe.count === usageNow.count && dMe.bytes === usageNow.bytes,
    JSON.stringify({ page: { count: dMe.count, bytes: dMe.bytes }, usage: usageNow }))
  check('我的③：1 张时可清（canClear 标记）', dMe.canClear === true)
  await shot(mp, 'me-one') // ★ 交付截图：我的页有 1 张作品时（清空前）

  await ensureModalMock()
  await resetModalLog()
  const clearBtn = await rpc(page.$('.clear-btn'), '$ .clear-btn')
  if (!clearBtn) throw new Error('我的页上没有 .clear-btn（wxml 改了？选择器跟着改）')
  await rpc(clearBtn.tap(), 'tap .clear-btn')
  // ⚠️ tap() 只把事件推进去、不 await handler（实测效果 ~300ms 后落地）—— 读之前先轮询，
  // 别一拍定生死（Task 18 第一轮就栽在这上面：④⑤⑥ 全读到点击前的世界）。
  let modalMe = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      modalMe = await evalJson(function () {
        return JSON.stringify({ calls: globalThis.__modalCalls || 0, title: globalThis.__modalTitle || '' })
      })
      if (modalMe.calls > 0) break
      await sleep(200)
    }
  }
  check('我的④：点「清空」弹的是「清空本地作品？」确认框',
    !!modalMe && modalMe.calls === 1 && modalMe.title === '清空本地作品？', JSON.stringify(modalMe))
  let manCleared = await readManifest()
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000 && manCleared.length !== 0) { await sleep(200); manCleared = await readManifest() }
  }
  const usageCleared = { count: manCleared.length, bytes: manCleared.reduce((s, e) => s + e.bytes, 0) }
  check('我的⑤：清空后 usage 归零（0 张 / 0 字节）',
    usageCleared.count === 0 && usageCleared.bytes === 0, JSON.stringify(usageCleared))
  let namesCleared = await dirList()
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000 && namesCleared.length !== 0) { await sleep(200); namesCleared = await dirList() }
  }
  check('我的⑥：works 目录里的文件没了', namesCleared.length === 0, 'files=' + JSON.stringify(namesCleared))
  dMe = await waitData(page, x => x.count === 0, 8000)
  check('我的⑦：清完页面数字自己刷新（0 张 + 置灰数据标记 canClear=false）',
    dMe.count === 0 && dMe.usageText === '0 张' && dMe.canClear === false,
    'count=' + dMe.count + ' text=' + dMe.usageText + ' canClear=' + dMe.canClear)
  await shot(mp, 'me-empty')

  // ── [8] 重存一张（[7] 清掉后给长按删当靶子）→ 长按删（mock showModal 自动确认）──
  log('\n[8] 重存一张 → 长按删：mock showModal 自动确认')
  page = await rpc(mp.switchTab('/pages/index/index'), 'switchTab index')
  await rpc(mp.evaluate(function () {
    const ps = getCurrentPages()
    const p = ps[ps.length - 1]
    p.probeSaveWork = null
    return JSON.stringify(true)
  }), 'clear probeSaveWork')
  page.callMethod('__probeSaveWork').catch(() => { /* 结果看字段，不看这个 promise */ })
  let probeAgain = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      probeAgain = await evalJson(function () {
        const ps = getCurrentPages()
        const p = ps[ps.length - 1]
        return JSON.stringify(p && p.probeSaveWork ? p.probeSaveWork : null)
      })
      if (probeAgain && probeAgain.state !== 'running') break
      await sleep(250)
    }
  }
  check('重存①：再次收进 1 张（长按删的靶子就位）', !!probeAgain && probeAgain.state === 'ok', JSON.stringify(probeAgain))
  if (!probeAgain || probeAgain.state !== 'ok') {
    await shot(mp, 'smoke-works-fail')
    throw new Error('重存没成功，长按删那一排断言没法跑（why 见上）')
  }
  page = await rpc(mp.switchTab('/pages/works/works'), 'switchTab works')
  await waitData(page, x => x.items.length === 1, 8000) // 等 onShow 刷出来（下面删除⑤还要看它回 0）
  const e0r = (await readManifest())[0] // 重存这一张的条目（e0 那批文件已在 [7] 清掉了）
  await ensureModalMock()
  await resetModalLog()
  // 直接调页面的长按 handler（automator 模拟长按不稳，brief 口径）—— 事件对象只要它读的字段
  await rpc(page.callMethod('onLongPressItem', { currentTarget: { dataset: { id: e0r.id } } }), 'callMethod onLongPressItem')
  const modal = await evalJson(function () {
    return JSON.stringify({ calls: globalThis.__modalCalls || 0, title: globalThis.__modalTitle || '' })
  })
  check('删除①：弹的是「删除这张作品吗？」确认框', modal.calls === 1 && modal.title === '删除这张作品吗？', JSON.stringify(modal))
  let man2 = await readManifest()
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000 && man2.length !== 0) { await sleep(200); man2 = await readManifest() }
  }
  check('删除②：清单回到 0', man2.length === 0, 'len=' + man2.length)
  const stGone1 = await fsStat(e0r.file)
  const stGone2 = await fsStat(e0r.thumb)
  check('删除③：全尺寸文件没了', stGone1.ok === false, JSON.stringify(stGone1))
  check('删除④：缩略图没了', stGone2.ok === false, JSON.stringify(stGone2))
  const dAfter = await waitData(page, x => x.items.length === 0, 8000)
  const emptyAgain = await rpc(page.$('.empty-title'), '$ .empty-title')
  check('删除⑤：网格回空态（items 0 + 空态文案回来）',
    dAfter.items.length === 0 && emptyAgain !== null, 'items=' + dAfter.items.length)
  await shot(mp, 'works-deleted')

  // ── [9] cap 满了：拒绝 + 不写半张（往清单灌一条"快满"的夹具，别真存 150MB）────
  log('\n[9] cap 满了：拒绝 + 不写半张')
  await rpc(mp.evaluate(function (payload) {
    wx.setStorageSync(payload.key, [
      { id: 'cap-fixture', file: '(fixture)', thumb: '(fixture)', w: 1, h: 1, bytes: payload.near, at: 1 },
    ])
    return JSON.stringify(true)
  }, { key: WORKS_KEY, near: 150 * 1024 * 1024 - 1000 }), 'inject cap fixture')
  page = await rpc(mp.switchTab('/pages/index/index'), 'switchTab index')
  await rpc(mp.evaluate(function () {
    const ps = getCurrentPages()
    const p = ps[ps.length - 1]
    p.probeSaveWork = null
    return JSON.stringify(true)
  }), 'clear probeSaveWork')
  page.callMethod('__probeSaveWork').catch(() => { /* 结果看字段 */ })
  let probeCap = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      probeCap = await evalJson(function () {
        const ps = getCurrentPages()
        const p = ps[ps.length - 1]
        return JSON.stringify(p && p.probeSaveWork ? p.probeSaveWork : null)
      })
      if (probeCap && probeCap.state !== 'running') break
      await sleep(250)
    }
  }
  check('cap①：清单快满时 add 拒绝、错误文案可辨识（就是那条专属 toast 的原话）',
    !!probeCap && probeCap.state === 'fail' && probeCap.why === '作品放满了，去「我的」清一清',
    JSON.stringify(probeCap))
  const namesAfterCap = await dirList()
  check('cap②：目录里没被写半张（拒绝发生在落文件之前）', namesAfterCap.length === 0, 'files=' + JSON.stringify(namesAfterCap))
  await rpc(mp.evaluate(function (key) {
    wx.removeStorageSync(key)
    return JSON.stringify(true)
  }, WORKS_KEY), 'remove cap fixture')
  check('cap③：清掉夹具后清单干净（收尾）', (await readManifest()).length === 0)

  // ── [10] 清单写失败：刚 copy 的两个文件要被清掉（mock setStorageSync 抛）────────
  // T18 复审 M2 的靶子：文件已 copy 进目录、清单却写不下来的那一步。mock 里直接
  // throw —— setStorageSync 是 Sync API，调用方（works.ts 的 writeManifest）会当场
  // 吃到异常（同步 API 的 mock 语义就得是这样的"照面即炸"）。
  log('\n[10] 清单写失败：孤儿文件要清掉（mock setStorageSync 抛）')
  await rpc(mp.mockWxMethod('setStorageSync', function () {
    throw new Error('mock: storage boom')
  }), 'mock setStorageSync (throw)')
  mocked.push('setStorageSync')
  await rpc(mp.evaluate(function () {
    const ps = getCurrentPages()
    const p = ps[ps.length - 1]
    p.probeSaveWork = null
    return JSON.stringify(true)
  }), 'clear probeSaveWork')
  page.callMethod('__probeSaveWork').catch(() => { /* 结果看字段，不看这个 promise */ })
  let probeOrphan = null
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      probeOrphan = await evalJson(function () {
        const ps = getCurrentPages()
        const p = ps[ps.length - 1]
        return JSON.stringify(p && p.probeSaveWork ? p.probeSaveWork : null)
      })
      if (probeOrphan && probeOrphan.state !== 'running') break
      await sleep(250)
    }
  }
  check('清单写失败①：add 拒绝、人话文案（「收进作品集失败：清单没能写下来」）',
    !!probeOrphan && probeOrphan.state === 'fail' && probeOrphan.why === '收进作品集失败：清单没能写下来',
    JSON.stringify(probeOrphan))
  const namesOrphan = await dirList()
  check('清单写失败②：刚 copy 的孤儿文件被清掉（目录 0 文件）', namesOrphan.length === 0, 'files=' + JSON.stringify(namesOrphan))
  check('清单写失败③：清单没留下半条（0 条）', (await readManifest()).length === 0)
  // 先还原一遍（留着也行 —— [11] 的 restoreMocks 还会幂等再兜一次；这里先还原是
  // 为了万一后面还有要写 storage 的动作不被这 mock 咬）。失败不 FATAL：防御性清理
  // 用的都不是 setStorageSync（rmdirSync / removeStorageSync），不依赖它先活过来。
  try { await rpc(mp.restoreWxMethod('setStorageSync'), 'restore setStorageSync', 8000) } catch (e) { log('  [restore setStorageSync 失败]', e && e.message) }
  // 不管成败都清干净（万一 mock 没炸穿、真存下了一张，别把脏状态留给 [11]）
  await rpc(mp.evaluate(function (key) {
    const fsm = wx.getFileSystemManager()
    try { fsm.rmdirSync(wx.env.USER_DATA_PATH + '/works', true) } catch (e) { /* 没有就罢 */ }
    try { wx.removeStorageSync(key) } catch (e) { /* 同上 */ }
    return JSON.stringify(true)
  }, WORKS_KEY), 'cleanup after orphan test')

  // ── [11] 收尾 ─────────────────────────────────────────────────────────────
  log('\n[11] 收尾：还原 mock、回修图页')
  await restoreMocks()
  page = await rpc(mp.switchTab('/pages/index/index'), 'switchTab index')
  log('    已回：', page.path)

  try { await rpc(mp.disconnect(), 'disconnect', 10000) } catch (e) { /* 没连上也就算了 */ }
  const fail = results.filter(r => !r.ok)
  log('\n══════ 汇总：' + (results.length - fail.length) + '/' + results.length + ' 过 ══════')
  if (fail.length) {
    fail.forEach(f => log('  ❌ ' + f.name))
    log('（截图见 .superpowers/mini/works-*.png / me-*.png / smoke-works-fail-*.png）')
    process.exit(1)
  }
  process.exit(0)
})().catch(async e => {
  console.error('FATAL:', e && e.message ? e.message : e)
  try { await restoreMocks() } catch (e2) { /* 尽力而为 */ }
  process.exit(1)
})
