// 「说一句」的 mock 后端（Task 12）—— **不花钱、不连网** 的本地替身。
//
// 为什么有它：真后端要配微信钥匙（code2session）+ 真模型（商汤 4~8.5s 一次、串行队列），
// 而「说一句」的冒烟要跑**四条决策路 + 停止**，不可能每次都打真钱。这里按
// `shared/protocol.ts` 的字段名回固定的决策与一张本地测试照片，冒烟靠它验数据流；
// 真后端那条路等 Task 13 真机验收（设计 §8）。
//
// 用法（冒烟脚本自己会起它，手动调试时）：
//   node mini/scripts/mock-server.cjs &          # 监听 4399
//   curl -s -X POST http://127.0.0.1:4399/api/route \
//        -d '{"text":"把路人去掉"}' -H 'content-type: application/json'
//
// 端点：
//   POST /api/wx-login    假票一张（apiPost → getToken 的静默登录会打到这里）
//   POST /api/route       按**文本关键词**给四种决策（见下面 DECISION 表）
//   POST /api/edit        回一张本地测试照片的 dataURL（默认 test-photos/e2e_after_generate.jpg，
//                         1216×800 —— 故意和 dev 测试图 1080×2048 尺寸不同，
//                         冒烟才能断言「照片真换了」）
//   GET  /mock/health     {ok:true,...}，冒烟等它就绪
//   GET  /mock/set        ?editMs=800&routeMs=200 运行期改延时（冒烟控节奏用）
//   GET  /mock/stats      {route,edit,editAborted,wxLogin} —— editAborted>0 是
//                         「停止」真的掐断了服务端连接（不是只改了界面）的**证据**
//
// 环境变量：MOCK_PORT（默认 4399）、MOCK_EDIT_MS（默认 3000）、MOCK_ROUTE_MS（默认 300）
//
// ⚠️ 它是**测试替身**，故意不做鉴权 / 限流 / 队列 —— 真后端那些都在 server/app.ts，
//    别照这儿的做法改那边，也别拿它当"接口文档"（字段形状以 shared/protocol.ts 为准）。
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.env.MOCK_PORT || 4399)
/** `/api/edit` 的「想一会儿」时长 —— 冒烟把它调大（>5s）来看蒙层的秒数文案 */
let editMs = Number(process.env.MOCK_EDIT_MS || 3000)
/** `/api/route` 的延时 —— 冒烟把它调大（~1.2s）来看输入条的「在想…」 */
let routeMs = Number(process.env.MOCK_ROUTE_MS || 300)

// ── 那张"生成结果"照片：候选按顺序取第一张存在的 ────────────────────────────
const REPO = path.join(__dirname, '..', '..')
const PHOTO_CANDIDATES = [
  path.join(REPO, 'test-photos', 'e2e_after_generate.jpg'), // 1216×800 横图
  path.join(REPO, 'test-photos', 'e2e_portrait.jpg'),       // 1080×2048 竖图
  path.join(__dirname, '..', 'assets', 'test-photo.jpg'),   // 打包兜底
]
const PHOTO = PHOTO_CANDIDATES.find((p) => fs.existsSync(p))
if (!PHOTO) {
  console.error('[mock] 三张候选测试照片都不在，退不了：\n  ' + PHOTO_CANDIDATES.join('\n  '))
  process.exit(1)
}
const PHOTO_BUF = fs.readFileSync(PHOTO)
const PHOTO_URL = 'data:image/jpeg;base64,' + PHOTO_BUF.toString('base64')
const PHOTO_SIZE = jpegSize(PHOTO_BUF)

/** 从 JPEG 字节里解出真实宽高（SOFn 段；和探针那套是同一段逻辑） */
function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const m = buf[i + 1]
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    }
    i += 2 + len
  }
  return { width: 0, height: 0 }
}

// ── 决策表（按用户那句话里的关键词走；四路都要能验到）──────────────────────
//   「亮一点」 类      → params（参数增量 = 内置「通透提亮」那一套的**全量**，
//                        从零参数出发叠加后恰好全等 → 冒烟能断言那一格真的点亮）
//   「把路人去掉」类    → generate
//   两类词都有          → both（先加对比度再生成 —— 冒烟在蒙层期间就能读到参数已生效）
//   「随便/拿不准」      → generate + degraded:true（验浮条那半句提醒话术）
//   「那个人/哪个」      → needsDisambiguation（参数照样应用、生成拦住）
const WANT_PARAMS = /亮|提亮|暖|鲜艳|通透/
const WANT_GEN = /路人|去掉|修掉|背景|痘痘/
const EDIT_PROMPT = 'remove the passers-by in the background, keep the person and the composition unchanged'

/** 决策的返回体（`RouteResponse`）：所有字段都按 shared/protocol.ts，一个字母别改 */
function decide(text) {
  if (/拿不准|随便/.test(text)) {
    return dec('generate', {}, '好，我大概懂了。', { degraded: true })
  }
  if (/那个人|哪个/.test(text)) {
    // ★ 形状按**后端口径**（server/validate.ts + validate.test.ts「模型说不确定、
    //   参数空」那条）：模型说"我不确定"、又没给 edit_prompt 时，服务端把 route
    //   归成 **'params'**（"零成本、可逆的那条路"）、editPrompt 清空 —— 前端才会
    //   "参数照收、生成拦住"。别写成 generate + editPrompt（真后端不会吐那种组合，
    //   写了的话这条冒烟就在测一个不存在的形状）。
    return dec('params', { exposure: 6 }, '好，我在照片里没找到很明确的那一处。',
      { needsDisambiguation: true })
  }
  const p = WANT_PARAMS.test(text)
  const g = WANT_GEN.test(text)
  if (p && g) return dec('both', { contrast: 20 }, '好，先加深一点对比，再把路人去掉。')
  if (p) {
    // 这一套就是内置预设「通透提亮」的值（src/core/presets.ts）—— 从全零叠加后全等，
    // activeStyle 应当亮起它。改预设值时这里不跟的话，冒烟会红（那正是它的用处）。
    return dec('params',
      { exposure: 16, contrast: 8, highlights: -20, shadows: 26, saturation: 6, clarity: 14 },
      '好，我把照片调成了通透提亮的样子。')
  }
  if (g) return dec('generate', {}, '好，这就把背景里的路人去掉。')
  return dec('generate', {}, '好，这就按你说的修。')
}

/** 拼一个完整决策（`lut`/`preset` 必填 null —— 小程序第一版没有这两样） */
function dec(route, paramDeltas, reply, extra = {}) {
  return {
    route,
    paramDeltas,
    reply,
    editPrompt: route === 'generate' || route === 'both' ? EDIT_PROMPT : '',
    needsDisambiguation: false,
    degraded: false,
    lut: null,
    preset: null,
    ...extra,
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const stats = { route: 0, edit: 0, editAborted: 0, wxLogin: 0 }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((ok) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { ok(JSON.parse(raw || '{}')) } catch { ok(null) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  // 掐断的套接字上别炸（客户端 abort 时 res 写入会报错 —— 那是预期内）
  res.on('error', () => {})
  const url = new URL(req.url, 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname === '/mock/health') {
    return sendJson(res, 200, { ok: true, editMs, routeMs, photo: PHOTO, ...PHOTO_SIZE })
  }
  if (req.method === 'GET' && url.pathname === '/mock/set') {
    if (url.searchParams.has('editMs')) editMs = Number(url.searchParams.get('editMs'))
    if (url.searchParams.has('routeMs')) routeMs = Number(url.searchParams.get('routeMs'))
    console.log(`[mock] 改延时：editMs=${editMs} routeMs=${routeMs}`)
    return sendJson(res, 200, { ok: true, editMs, routeMs })
  }
  if (req.method === 'GET' && url.pathname === '/mock/stats') {
    return sendJson(res, 200, stats)
  }

  if (req.method === 'POST' && url.pathname === '/api/wx-login') {
    stats.wxLogin++
    if (!(await readBody(req))) return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '正文不是 JSON' } })
    console.log('[mock] wx-login：发一张假票')
    return sendJson(res, 200, {
      user: { id: 1, username: '微信用户_模拟', email: 'wx-mock@wechat.local' },
      token: 'mock-token-not-a-real-credential',
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/route') {
    const body = await readBody(req)
    if (!body) return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '正文不是 JSON' } })
    stats.route++
    const decision = decide(String(body.text || ''))
    console.log(`[mock] route「${String(body.text || '').slice(0, 30)}」→ ${decision.route}` +
      `${decision.degraded ? ' degraded' : ''}${decision.needsDisambiguation ? ' 拿不准' : ''}` +
      `（body 里带没带 params：${body.params ? '有' : '没有'}；图 ${String(body.imageDataUrl || '').slice(0, 30)}…）`)
    return setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { decision })
    }, routeMs)
  }

  if (req.method === 'POST' && url.pathname === '/api/edit') {
    const body = await readBody(req)
    if (!body) return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '正文不是 JSON' } })
    stats.edit++
    console.log(`[mock] edit：${editMs}ms 后交图（prompt「${String(body.editPrompt || '').slice(0, 40)}」）`)
    // 「停止」= 客户端 abort → 连接断掉。清掉定时器、别写回一个没人收的响应，
    // 并记一笔 —— `/mock/stats` 里 editAborted>0 就是"服务端真的跟着停了"的证据。
    // ⚠️ 挂在 `res` 的 close 上（不是 req）：req 的 close 在正文收完时就到了，
    //    判不出"人是中途走的"；res 的 close + !writableEnded 才是那个信号
    //    （Node ≥16 起 res 提前断开也会发 close —— 2026-10-12 实测过：
    //    挂 req 上时 curl -m 0.2 掐断，计数器纹丝不动）。
    const timer = setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      sendJson(res, 200, { imageDataUrl: PHOTO_URL, width: PHOTO_SIZE.width, height: PHOTO_SIZE.height })
    }, editMs)
    res.on('close', () => {
      if (!res.writableEnded) {
        clearTimeout(timer)
        stats.editAborted++
        console.log('[mock] edit：客户端掐断了连接（停止），这一趟不回了')
      }
    })
    return
  }

  sendJson(res, 404, { error: { code: 'BAD_REQUEST', message: 'mock 没有这个端点：' + url.pathname } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 在 http://127.0.0.1:${PORT} 上等着（editMs=${editMs} routeMs=${routeMs}）`)
  console.log(`[mock] 生成结果照片：${PHOTO}（${PHOTO_SIZE.width}×${PHOTO_SIZE.height}）`)
})
