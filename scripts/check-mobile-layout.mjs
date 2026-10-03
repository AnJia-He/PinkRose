/**
 * 检查：手机屏幕上，照片看得见吗？
 *
 * 为什么需要单独一条 —— **现有四样检查天生看不见这类 bug**：
 *
 * | 检查 | 为什么看不见 |
 * |---|---|
 * | 227 条测试 | jsdom **没有排版引擎**，getBoundingClientRect() 一律返回 0 |
 * | typecheck | 不看 CSS |
 * | vite build | 不看 CSS |
 * | check-dev-urls | 只问文件拿不拿得到 |
 *
 * 2026-09-23 连着栽了两次，两次都是"四样全绿、只有用户手机上看得见"：
 *
 *   1. `.chat` 写死 340px（`flex: none`），390px 的手机上画布只剩 **10×13** ——
 *      用户的原话是"没有照片"。
 *   2. 打开「调色」后，照片 / 对话 / 面板三样抢竖向空间，照片被压到 **64×86**——
 *      "图片小到看不见"。
 *
 * 所以这条检查量的是**画布在屏幕上占多大**（getBoundingClientRect），
 * 不是它的内部像素 —— 画布内部 3076×4096、屏幕上是 10×13，那两回事，
 * 而用户看见的只有后者。
 *
 * 判据用"长边 / 短边"而不是面积：手机拍的是竖图、仓库里的样片是横图，
 * 两种比例都得过。按面积判会在换一张比例不同的样片时莫名其妙地红。
 *
 * ⚠️ 三个容易写错的地方，这条脚本自己踩过：
 *   1. **必须掐掉 `/api/suggest`。** 那一路是真调模型的（花钱），而这条检查
 *      每次都要跑。卡片是可选件，掐掉不影响版面。
 *   2. **不能只看"元素存不存在"**。对话被隐藏时，输入框仍然拿得到（尺寸 0），
 *      拿存在性当判据等于白判。所以先看宽度 > 0 再判它在不在屏内。
 *   3. **量的是哪个构建，必须自己先证明**（2026-09-23 加，见 checkServedBuild）。
 *      这条检查量的是**跑在 5173 上的那份构建**，不是源码 —— 它一直可以安安静静地
 *      量一棵旧树、然后给你一个绿。这一轮就真撞上了一个 10:09 起的旧
 *      `vite preview` 占着 5173（strictPort 让自己的那个起不来），当时靠人工对哈希才发现。
 *
 * 2026-09-23 还加了两件**自动化覆盖一直是零**的东西（见下面 §图上点选）：
 *   4. 红圈的几何：屏幕坐标 → 归一化坐标 → 红圈圆心。这条线上买的是**一次生成的
 *      钱**（约 12,900 tokens），此前唯一的证据是 gitignore 目录里的一次性探针。
 *   5. 真的 `makeThumbnail`（对话里那张小图）。jsdom 那条测试整个把它假掉了，
 *      真函数没人验过；这里量的是它的产出真有像素。
 *
 * 2026-09-25 加了第 6 件（Task 13，§6.6 ①）：**存失败之后那一屏**。那一刻用户改好的
 * 图只在屏幕上，横幅上那个「下载到电脑」是他唯一的出口 —— 而它是 flex 排的，
 * 窄屏上会不会被 `.app` 悄悄切掉，jsdom 量不出来（见下面 measureSaveFail）。
 * 存不进去（413）是拦出来的：真服务器只在单张图超过 8 MB 时才 413，造不出来。
 *
 * 2026-09-25 又加了第 7 件：**作品页列表上那张缩略图的清晰度**（源像素够不够它被
 * 显示出来用的）。这一件是"用户先在真屏幕上看见了、四样检查全绿"的第二个例子 ——
 * 缩略图在 181px 的正方格里被拉大 1.51×（DPR 2 的屏上 3.02×），而当时**没有任何
 * 检查在量这个比值**（见 judgeGallery 里 `thumbCoverage` 那一段）。
 *
 * 用法（服务器开着就行；dev 或 preview 都可以，脚本自己会核对是哪一版）：
 *   npm run dev                    （或者 npm run build && npm run preview）
 *   npm run check:layout
 *
 * ⚠️ 2026-09-25 起：修图界面在**登录墙**后面（Task 7 的前端登录页），打开页面先看到的
 * 是登录页、`input[type="file"]` 压根不在 DOM 里。所以脚本现在**先现注册一个临时账号**
 * 再往下量 —— 为什么这么选，见下面「先登录，再量」那一段注释。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
/**
 * ⚠️ **从应用源码里拿**作品页那张缩略图的边长上限，不在这里另写一个数。
 *
 * 下面 seed 进库的那张缩略图是**照着应用的做法**造的（同一个 `fitWithin`、同一个上限），
 * 它和真应用必须永远是同一个数 —— 写两份就会漂，而漂了的样子是"检查绿着、用户那边糊着"
 * （这一条判据本身就是为那个洞加的）。上面 `GALLERY_FIRST` 那种"和某个常量同一个数"
 * 的注释式同步，在这里不够：**那张图是这条检查唯一的夹具**。
 *
 * node 24 直接吃 `.ts`（`server/index.ts` 也是这么跑的），而 `src/core/thumbnail.ts`
 * 只有纯函数和常量，import 它不会碰 DOM。
 */
import { GALLERY_THUMB_MAX_SIDE } from '../src/core/thumbnail.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const URL = process.env.DEV_BASE ?? 'http://localhost:5173'
/** ★ 这个脚本量的是 **App**，而 App 从 2026-09-30 起住在 `/app` 底下
 *  （`/` 让给了落地页）。所以下面每一处导航都写死 `/app/...` ——
 *  漏改一处的表现是"等一个永远不出现的 `.login-box` 等到超时"，
 *  报错信息里看不出"只是走错门了"，所以在这儿说一句。 */
const APP = `${URL}/app`
/** 仓库里已有的样片，不必另存一张大图。比例是横的（1200×800），
 *  而真机是竖的 —— 两种都要能过，所以判据用的是长边/短边。 */
const PHOTO = join(ROOT, 'test-photos', 'e2e_first_use.jpg')

/** 本仓库刚构建出来的那一版。用来核对服务器发的到底是哪一版。 */
const DIST_HTML = join(ROOT, 'dist', 'index.html')
/** 静态构建引用的资源（`/assets/index-<内容哈希>.js|css`）。
 *  dev 服务器发的是 `/src/main.tsx` 那种，压根没有这个。 */
const ASSET_RE = /\/assets\/[A-Za-z0-9._-]+/g

/**
 * 量之前先证明：**服务器上跑的就是你刚构建的那一版**。
 *
 * 为什么非查不可：这条检查量的是**服务器上那份构建**，不是源码。所以它能被
 * 一整类"假绿"骗过去 —— 那个端口上占着一个更早起的服务器、或者别的目录起的一个，
 * 它照样量、照样给你 ✅。2026-09-23 真撞到过一次（一个 10:09 起的旧
 * `vite preview` 占着 5173，strictPort 让新起的那个直接退出），当时靠人工
 * 对哈希才没量错 —— **这种运气不该是流程的一部分**。
 *
 * 判据（两边的文件名都带内容哈希，所以哈希不同 = 版本不同）：
 *   - 发的是 vite **dev** 服务器 → 它现读现发源码，天然就是你手上这棵树，放行；
 *   - 发的是**静态构建** → `/index.html` 引用的资源必须和本仓库 `dist/index.html`
 *     引的一致，不一致就**报错退出**，说清"那上面跑的不是你刚构建的这一版"。
 *   - 两样都不是 → 也报错退出（**不许静默地量下去**）。
 *
 * ⚠️ 这条判据管的是"服务器发的是不是这份 dist"，**管不到"这份 dist 是不是 HEAD
 * 构建的"** —— 忘了 `npm run build` 时它照样绿（那时量的是旧的 dist，但服务器
 * 和 dist 自洽）。所以 `npm run build` 仍然是必须的，见文件开头那三行用法。
 */
async function checkServedBuild() {
  let html
  try {
    html = await (await fetch(URL, { headers: { accept: 'text/html' } })).text()
  } catch {
    console.log(`❌ 连不上 ${URL} —— 服务器开着吗？（npm run dev 或 npm run preview）`)
    process.exit(1)
  }
  if (html.includes('/@vite/client')) return 'dev 服务器（现读现发源码）'

  const served = [...new Set(html.match(ASSET_RE) ?? [])]
  if (served.length === 0) {
    console.log(`❌ 看不出 ${URL} 上跑的是什么：它发的既不是 vite dev 服务器，`)
    console.log('   也不是带哈希资源的静态构建。停在这里，不量了 ——')
    console.log('   要么 npm run dev，要么 npm run build && npm run preview。')
    process.exit(1)
  }

  let dist
  try {
    dist = readFileSync(DIST_HTML, 'utf8')
  } catch {
    console.log(`❌ ${URL} 发的是静态构建，但本地没有 ${DIST_HTML}：没有能拿来对的东西。`)
    console.log('   先 npm run build（构建完再 npm run preview），别拿它的数字当真。')
    process.exit(1)
  }
  const missing = served.filter(a => !dist.includes(a))
  if (missing.length > 0) {
    console.log(`❌ ${URL} 上跑的**不是你刚构建的那一版**：`)
    console.log(`   它发的资源是 ${served.join(' / ')}`)
    console.log(`   而 dist/index.html 引的是 ${[...new Set(dist.match(ASSET_RE) ?? [])].join(' / ')}`)
    console.log(`   对不上的有 ${missing.join(' / ')}。`)
    console.log(`   多半是 ${URL} 上占着一个更早起的服务器（也可能是另一个目录起的）。`)
    console.log('   **不许拿它的数字当真**：先把它弄成同一版，' +
      '或者换个端口 DEV_BASE=http://localhost:<口> 再跑。')
    process.exit(1)
  }
  return `静态构建 ${served.join(' / ')}（与 dist/index.html 一致）`
}

/**
 * 量哪几屏。
 *
 * 手机那一档是原来就有的（iPhone 14；窄屏断点是 640，所以它落在"上下排"那一侧）：
 * 那一档里画布是被**宽度**卡住的（390 − 40 内边距 = 350），也就是说**高度那条链
 * 从来没被激活过** —— 把 .canvas-wrap 的 height: 100% 摘掉，它照样全绿。
 *
 * 2026-09-23 补桌面这一档 1280×600：走**左右排**，而且**横竖都短** ——
 * 高度那条链（.stage 的 flex 高度 → .canvas-wrap 的 height: 100% →
 * .canvas 的 max-height: 100%）只有在"高度真的不够"的屏上才会吃上劲。
 */
const VIEWS = [
  { name: '手机 390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: '桌面 1280x600', width: 1280, height: 600, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
]
const MIN_LONG = 240   // 照片的长边至少这么长，否则就是"一个点"
const MIN_SHORT = 150  // 短边也不能是一条
/** 1px 容差：子像素舍入会稳定地差一个像素，而"差 1px"不是用户看得见的问题。 */
const TOL = 1

/** 量一屏。返回画布在**屏幕上**的尺寸，和几个辅助判据。 */
async function measure(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const c = document.querySelector('canvas')
    const bar = document.querySelector('.topbar')
    return {
      canvas: box(c),
      canvasPixels: c ? `${c.width}x${c.height}` : null,
      input: box(document.querySelector('form.chat-input')),
      buttons: [...document.querySelectorAll('.actions button')].map(b => b.textContent),
      topbarOverflow: bar ? bar.scrollWidth > bar.clientWidth : false,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

const fails = []
function judge(label, m, view) {
  const c = m.canvas
  const long = Math.max(c.w, c.h)
  const short = Math.min(c.w, c.h)
  console.log(`── ${label}`)
  console.log(`     画布（屏幕上） ${c.w}x${c.h} @${c.left},${c.top}   （内部像素 ${m.canvasPixels}）`)
  console.log(`     顶栏按钮 ${m.buttons.join(' / ')}`)
  if (long < MIN_LONG || short < MIN_SHORT) {
    fails.push(`${label}：照片在屏幕上只有 ${c.w}x${c.h} —— 用户看不见（至少要 ${MIN_LONG}x${MIN_SHORT}）`)
  }
  // 顶栏挤爆过一次（一个按钮就能挤），所以按**最坏情况**量：见下面注入的那段。
  if (m.topbarOverflow) {
    fails.push(`${label}：顶栏放不下这些按钮（${m.buttons.join(' / ')}）`)
  }
  // 输入框被隐藏时尺寸是 0，这时候不该判它 —— 否则是拿"存在"当"可见"
  if (m.input && m.input.w > 0 && m.input.bottom > view.height + 1) {
    fails.push(`${label}：输入框底边 ${m.input.bottom} 超出屏幕 ${view.height}`)
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
  // ★ 2026-09-23 加。上面那四条**一条都看不见"被切掉"**：`.app` 是 overflow: hidden，
  //   画布比 stage 高的话是被**切掉**的 —— 不出滚动条、不横向溢出、输入框也还在屏内。
  //   用户看到的是"照片下半截没了"，而检查全绿。所以必须直接问"它整个在视口里吗"。
  //   ⚠️ 判据**不写死任何尺寸**，只比"在不在视口内"：换一张比例不同的样片时，
  //   按尺寸判会莫名其妙地红（文件开头那条理由）。
  if (c.top < -TOL || c.left < -TOL || c.bottom > view.height + TOL || c.right > view.width + TOL) {
    fails.push(
      `${label}：画布没有完整落在视口里（${c.w}x${c.h} @${c.left},${c.top}，` +
      `视口 ${view.width}x${view.height}）—— 超出屏幕的那部分被切掉了，用户看不全照片`)
  }
}

// ── 2026-09-23 加：图上点选 + 真的缩略图 ─────────────────────────────
//
// 这两样以前**自动化覆盖为零**：`src/App.test.tsx` 把 `./ui/Canvas` 整个假掉
// （假画布把屏幕坐标除以写死的 1000，和真几何毫无关系），`mark.test.ts` 只测纯
// 几何，`markImage` 的绘制和 DOM 红圈的位置没人量。于是「看着对、其实错、还照
// 收钱」这种性质（R14 / 圈的大小）唯一的证据是 gitignore 目录里的一次性探针。
// 这里把它变成可复跑的判据 —— **全程零真实模型调用**。

/** 假造的路由决策：模型说"拿不准，让用户在图上点一下"。
 *  **必须是假造的**：真调 /api/route 要花钱，而这条检查每次都跑。
 *  形状照 `shared/protocol.ts` 的 `RouteResponse = { decision }`。 */
const FAKE_DECISION = {
  decision: {
    route: 'generate',
    paramDeltas: {},
    reply: '好。',
    editPrompt: '把后面那个人去掉',
    needsDisambiguation: true,
    degraded: false,
  },
}

/** 点画布盒子的哪个相对位置（0~1）。
 *  ⚠️ **故意不取正中**：画布是**居中**在 wrapper 里的，取正中时"按 wrapper 的
 *  百分比定位"这个错法算出来的位置和正确位置恰好重合（差 = 宽度差 × (x−0.5)，
 *  x=0.5 时为 0）—— 那条变异就验不出来了。取 0.2/0.35：桌面档画布 750 宽、
 *  wrapper ~900 宽，按 wrapper 定位会偏出 45px，一眼就红。 */
const PICK_AT = { fx: 0.2, fy: 0.35 }
/** 红圈圆心的容差。取 2px：这条要抓的偏差是几十像素（R14 那类是 45~288px），
 *  而子像素舍入稳定地差不到 1px。 */
const MARKER_TOL = 2

/** 画布在屏幕上的盒子（**不取整** —— 点选要按它换算坐标）。 */
async function canvasRect(page) {
  return page.evaluate(() => {
    const b = document.querySelector('canvas').getBoundingClientRect()
    return { left: b.left, top: b.top, width: b.width, height: b.height }
  })
}

/** 量红圈和画布现在各自在屏幕上的哪里。 */
async function measurePick(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas')
    const m = document.querySelector('.canvas-marker')
    const cb = c?.getBoundingClientRect()
    const mb = m?.getBoundingClientRect()
    return {
      canvas: cb && {
        left: cb.left, top: cb.top, right: cb.right, bottom: cb.bottom,
        width: cb.width, height: cb.height,
      },
      // 圆心：红圈的盒子中心。margin 取的是半径的相反数，所以盒子中心 = 那个点。
      marker: mb && {
        cx: mb.left + mb.width / 2, cy: mb.top + mb.height / 2,
        w: mb.width, h: mb.height,
      },
    }
  })
}

/**
 * 判红圈的三件事。
 *
 * `expected` 传了就是"用户刚点的那个屏幕坐标"（量它的时候版面还没变）；
 * 不传就按它在**照片里的归一化位置**（PICK_AT）重新算 —— 版面变了（开合调色
 * 面板会把画布缩放）之后，圈必须还钉在照片上的同一个点，跑掉就是错的。
 */
function judgeMarker(label, m, expected) {
  console.log(`── ${label}`)
  if (!m.canvas || !m.marker) {
    // 取不到就响亮地红：底下的数字全靠它，静默跳过等于这条判据不存在。
    fails.push(`${label}：量不到红圈（画布 ${!!m.canvas} / 红圈 ${!!m.marker}）`)
    return
  }
  const c = m.canvas
  const k = m.marker
  const want = expected ?? {
    x: c.left + PICK_AT.fx * c.width,
    y: c.top + PICK_AT.fy * c.height,
  }
  // 圈该多大：**和送进图里的那个圈共用同一个公式**（长边的 12%，下限 16px
  // 直径 —— 见 src/image/mark.ts 的 markerRadius）。
  // 容差 2px：半径那一步是整数，长边差半个像素时可能进/退一位；要抓的偏差是几十像素。
  const wantD = 2 * Math.max(8, Math.round(0.06 * Math.max(c.width, c.height)))
  console.log(`     红圈 圆心 ${k.cx.toFixed(1)},${k.cy.toFixed(1)}  直径 ${k.w.toFixed(1)}` +
    `   （该在 ${want.x.toFixed(1)},${want.y.toFixed(1)}，该是 ${wantD}）`)
  console.log(`     画布 ${Math.round(c.width)}x${Math.round(c.height)} @${Math.round(c.left)},${Math.round(c.top)}`)

  // ① 圆心就在用户点的地方 —— 这一条买的是"送进模型的坐标和用户指的地方是同一个"。
  const dx = k.cx - want.x
  const dy = k.cy - want.y
  if (Math.abs(dx) > MARKER_TOL || Math.abs(dy) > MARKER_TOL) {
    fails.push(
      `${label}：红圈圆心在 ${k.cx.toFixed(1)},${k.cy.toFixed(1)}，` +
      `该在 ${want.x.toFixed(1)},${want.y.toFixed(1)}（偏了 ${dx.toFixed(1)},${dy.toFixed(1)}px）`)
  }
  // ② 整个圈落在**照片**上（不是落在 wrapper 的留白上）。
  if (k.cx - k.w / 2 < c.left - TOL || k.cx + k.w / 2 > c.right + TOL ||
      k.cy - k.h / 2 < c.top - TOL || k.cy + k.h / 2 > c.bottom + TOL) {
    fails.push(
      `${label}：红圈没落在照片上（圈心 ${k.cx.toFixed(1)},${k.cy.toFixed(1)}，` +
      `照片 ${Math.round(c.left)},${Math.round(c.top)}~${Math.round(c.right)},${Math.round(c.bottom)}）`)
  }
  // ③ 圈的大小 = 照片长边的 12%：用户看到多大的圈，模型就该收到多大的圈。
  //    原来 DOM 写死 44px —— 桌面档这里是 90，那条会红。
  if (Math.abs(k.w - wantD) > 2) {
    fails.push(
      `${label}：红圈直径 ${k.w.toFixed(1)}px，按画布长边算该是 ${wantD}px —— ` +
      `用户看到的是一个大小，送进图里的是另一个`)
  }
}

/** 对话里那张小图：真的 `makeThumbnail` 的产出（data URL）得真有像素。 */
async function judgeThumb(page, label) {
  let got
  try {
    await page.waitForFunction(
      () => (document.querySelector('.bubble-thumb')?.naturalWidth ?? 0) > 0,
      null, { timeout: 5_000 })
    got = await page.evaluate(() => {
      const img = document.querySelector('.bubble-thumb')
      return { nw: img.naturalWidth, nh: img.naturalHeight, isData: img.src.startsWith('data:image/') }
    })
  } catch {
    got = null
  }
  console.log(`── ${label} · 对话里那张小图`)
  if (!got) {
    fails.push(`${label}：对话里没有一张能解开的小图（.bubble-thumb 的 naturalWidth 是 0）——` +
      '「翻聊天记录就是撤销」的那个入口没了')
    return
  }
  console.log(`     .bubble-thumb ${got.nw}x${got.nh}（真图、${got.isData ? 'data URL' : '不是 data URL'}）`)
  if (got.nw <= 0 || got.nh <= 0) {
    // 上面 waitForFunction 已经保证 > 0，这里是"判据本身别写错"的保险
    fails.push(`${label}：小图上没有像素（${got.nw}x${got.nh}）`)
  }
}

// ── 2026-09-25 加（Task 11）：作品页的懒加载 ────────────────────────────
//
// §10 那张表里点名"真浏览器检查"的就是这一格：「作品多了要懒加载 | 造 500 条 →
// 首屏**不能一次全渲染**；往下滚才取后面的」。jsdom 验不了它 —— 没有排版引擎
// （格子一律 0×0）、没有滚动，连 IntersectionObserver 都是测试自己桩出来的。
//
// 数据分两半，两半的理由完全不同：
//   ① **先走真接口放几张**（图是页面里现画的一张小 JPEG）。它们必须真被摆出来、
//      缩略图真能解开：这一步是**下面那半假响应的守门人** —— 接口的形状要是
//      变了（比如 `{items}` 而不是 `{works}`），假响应会跟着一起错，量出来的
//      绿就是假的。
//   ② 那 500 条**只能造假**：作品的日期是服务器按"此刻"写的，一次造出来的 500
//      条全落在同一天，而 §3.5 的规矩是**按天取整**——同一天本来就该全摆出来
//      （不然标题写着「· 500 张」而下面只有 60 张，用户会以为丢了 440 张）。
//      所以"首屏 60"这条判据只在**跨天**的数据上成立，而今天造不出跨天的数据。
//
// 造出来的东西**不清理**，和上面那个临时账号一个道理：库是 dev 的、`data/` 已
// gitignore，这条检查本来干的就是"起一个干净环境量版面"。
const GALLERY_SEED = 3      // 走真接口放几张
const GALLERY_FAKE = 500    // 假响应里放几条（§10 说的"造 500 条"）
const GALLERY_FIRST = 60    // §3.5 的"先摆 60 张"，和 GalleryPage.tsx 里的 PAGE 是同一件事
const DAY_MS = 86_400_000

// ── 详情页 seed 的尺寸（终审 C1 的**一半**，另一半是下面那条判据）──────────
// seed 一张**竖图**：手机上一屏放不下，详情页才真的比一屏长（判据"详情页自己滚了"
// 才不是恒真）。600x900 在窄屏上是 350x525。
const SEED_IMAGE_W = 600
const SEED_IMAGE_H = 900
/** seed 那张缩略图的边长上限 —— **就是应用里给作品页用的那个数**
 *  （从 `src/core/thumbnail.ts` 直接 import 的 `GALLERY_THUMB_MAX_SIDE`，不另抄一份；
 *  2026-09-25 之前这里写死的是 160，和当时的 `THUMB_MAX_SIDE` 一样）。
 *  ⚠️ 它原来不是个单独的图：`{ image, thumb: image }` 把**同一张 600x900** 同时当原图和
 *  缩略图交上去，于是 `/thumb` 在检查里回的是**全尺寸图** —— 详情页那条判据（原来只判
 *  `naturalWidth > 0`）对"详情页拿的是缩略图"这件事**永远失明**，C1 就是这么溜过去的。 */
const SEED_THUMB_MAX = GALLERY_THUMB_MAX_SIDE
/** seed 原图的**长边** —— 详情页那条"拿到的必须是原图"的判据就对着它比。
 *  为什么比长边而不是只比 `naturalWidth`：seed 是一张 600x900 的**竖图**，
 *  `naturalWidth >= 900` 这种写法会让**正确**的实现也红（宽度只有 600）。 */
const SEED_IMAGE_LONG = Math.max(SEED_IMAGE_W, SEED_IMAGE_H)

/** 量作品页现在长什么样。 */
async function measureGallery(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }
    }
    const g = document.querySelector('.gallery')
    const more = document.querySelector('.gallery-more')
    return {
      cells: document.querySelectorAll('.gallery-cell').length,
      days: document.querySelectorAll('.gallery-day').length,
      dayTitle: document.querySelector('.gallery-day-title')?.textContent ?? null,
      // ⚠️ `hasBox` 量的是**有布局宽度**＝那个圈确实被渲染出来了、没被藏起来。
      // **没有**量它在不在视野内 —— 滚到底之后它是列表的最后一个子元素，
      // "它在不在视野里"几乎恒为真，那种断言是假的，这里不写。
      more: more ? { hasBox: more.getBoundingClientRect().width > 0, text: more.textContent } : null,
      end: !!document.querySelector('.gallery-end'),
      nav: box(document.querySelector('.nav')),
      listScroll: g ? Math.round(g.scrollTop) : null,
      docScroll: Math.round(window.scrollY),
      thumbsDecoded: [...document.querySelectorAll('.gallery-thumb')]
        .filter(i => i.naturalWidth > 0).length,
      // ★ 每张缩略图的**真实像素**和**它被摆出来的盒子**（2026-09-25 加）。
      //   这一对就是"糊不糊"的全部材料：`judgeGallery` 里那条判据拿它们相除。
      //   要乘 dpr 才是"屏幕上要多少设备像素"，所以 dpr 一起量回来。
      //   ⚠️ 盒子的宽高**不取整**：181.33 这种小数取整会白丢半像素，而它正是那条
      //   判据的分母（列表里那张图只有一档几像素的富余时，取整能把绿判成红）。
      dpr: devicePixelRatio,
      thumbs: [...document.querySelectorAll('.gallery-thumb')].map(i => {
        const b = i.getBoundingClientRect()
        return { natW: i.naturalWidth, natH: i.naturalHeight, w: b.width, h: b.height }
      }),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

/**
 * 那张缩略图**盖不盖得住**它被显示出来的尺寸（2026-09-25 加）。
 *
 * 为什么是这个式子：缩略图按**长边**缩（`fitWithin`），而 `.gallery-thumb` 是
 * `width: 100%; aspect-ratio: 1/1; object-fit: cover` —— **正方形框、按宽度铺**，
 * `cover` 的缩放系数 `max(框宽/图宽, 框高/图高)` 里起决定作用的是**短边**。
 * 两个方向各算一次、取小的那个，就是"屏幕上每个点有没有真实像素垫着"：
 *   ≥ 1 有；< 1 就是浏览器在**凭空造像素**（越大越糊）。
 * 不看 DPR 也不看 CSS 宽度：DPR 2 的屏只是把差距再乘一遍。
 */
function thumbCoverage(t, m) {
  return Math.min(t.natW / (t.w * m.dpr), t.natH / (t.h * m.dpr))
}

/**
 * 判作品页的**版面**（这一条检查的全部意义就在这儿，不管内容对不对）。
 *
 * 最要紧的一条是 `docScroll`：作品页是长列表，列表要是**不自己滚**、让整个
 * 文档滚，左栏那 92px 就会跟着划走、底色到一屏就断（这是 Task 10 交回去的
 * 那半个问题）。列表自己滚的话，文档永远不滚、左栏钉在原地。
 *
 * 2026-09-25 加的一条是**清晰度**（不是版面）：列表上那张缩略图的源像素够不够
 * 它被显示出来用的 —— 见下面那段。
 */
function judgeGallery(label, m, view) {
  console.log(`── ${label}`)
  console.log(`     作品 ${m.cells} 张 / ${m.days} 天，缩略图解出 ${m.thumbsDecoded} 张` +
    `，日期标题 ${m.dayTitle ?? '（没有）'}`)
  console.log(`     圈：${m.more ? `在（"${m.more.text}"，有布局宽度 ${m.more.hasBox}）` : '没有'}` +
    `   到底了那句：${m.end ? '说了' : '没说'}`)
  console.log(`     文档滚了 ${m.docScroll}px，列表自己滚了 ${m.listScroll}px，` +
    `左栏 ${m.nav ? `${m.nav.w}x${m.nav.h} @top ${m.nav.top}` : '**不在 DOM 里**'}`)

  // ── ★ 列表上那张缩略图：源像素够不够它被显示出来用的（2026-09-25 加）──────────
  //
  // **这个洞为什么能存在**：它糊了整整一轮而**没有任何检查在量它** ——
  // 227 条测试（jsdom 没有排版引擎、也没有真解码的图）、typecheck、build、
  // 这条布局检查自己，四样全绿。用户先在真屏幕上看见了。
  //
  // 判据只有一句：**两个方向上源都不该少于目标**（`thumbCoverage >= 1`）。
  // 它不是"看着挺清楚"这种主观线，而是"浏览器要不要凭空造像素"。
  //
  // ⚠️ **这一条只判桌面档**（`view.isMobile === false`）。web 是给电脑用的
  //    （2026-09-24 用户拍板，`specs/2026-09-24-accounts-and-gallery-design.md` 开头：
  //    "手机那侧交给小程序"），手机档留在这条脚本里的作用是抓**版面**坏掉
  //    （照片看不见、横向溢出），不是给缩略图的清晰度定政策。手机档的数字照打
  //    （下面那两行），只是不判 —— **不判不等于不说**。
  //    顺带一句实话：手机上（同一张 seed、DPR 2）这个数是 0.95，确实差一点点，
  //    因为 seed 是 2:3 的竖图、比真照片（3:4）更吃亏；那一档该不该管，
  //    等小程序那边定。
  const decoded = m.thumbs.filter(t => t.natW > 0)
  const worst = decoded.length === 0 ? null
    : decoded.reduce((a, b) => (thumbCoverage(a, m) <= thumbCoverage(b, m) ? a : b))
  if (worst) {
    console.log(`     缩略图 ×${decoded.length}（列里共 ${m.thumbs.length} 张），最差的那张 ` +
      `${worst.natW}x${worst.natH} 真实像素，盒子 ${worst.w}x${worst.h} CSS` +
      ` ×DPR ${m.dpr} = 要盖 ${Math.round(worst.w * m.dpr)}x${Math.round(worst.h * m.dpr)} 设备像素`)
    console.log(`     ★ 覆盖度 min(源/需要) = ${thumbCoverage(worst, m).toFixed(2)}` +
      `（< 1 就是被拉大的${view.isMobile ? '；手机档只打不判，理由见源码注释' : ''}）`)
  }

  if (m.cells === 0) {
    fails.push(`${label}：一张作品都没摆出来`)
  }
  // ★ 列表必须自己滚：整页滚动的话左栏跟着走
  if (m.docScroll > TOL) {
    fails.push(`${label}：整个文档被滚了 ${m.docScroll}px —— 作品页的列表该**自己滚**` +
      '（.gallery 的 overflow-y: auto）；这样滚下去左栏会被划走，它的底色到一屏就断了')
  }
  if (!m.nav || m.nav.top < -TOL || m.nav.w < 40 || m.nav.h < 24) {
    fails.push(`${label}：左栏不在屏幕上了（${m.nav ? `${m.nav.w}x${m.nav.h} @top ${m.nav.top}` : '不在 DOM 里'}）`)
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
  // ★★ 缩略图不许是"被拉大出来"的（理由见上面那一段）。
  //    变异：把 `GALLERY_THUMB_MAX_SIDE` 改回 160 → 这一条红（seed 那张缩略图跟着
  //    变成 107x160，盒子还是 181 上下）—— 它和夹具是**同一个数**的两端，改一边
  //    是量不出东西的（见文件上面 import 那段注释）。
  if (worst && !view.isMobile && thumbCoverage(worst, m) < 1) {
    fails.push(`${label}：列表上那张缩略图**是被拉大出来的**（源 ${worst.natW}x${worst.natH}，` +
      `盒子 ${worst.w}x${worst.h} CSS ×DPR ${m.dpr} = 要盖 ` +
      `${Math.round(worst.w * m.dpr)}x${Math.round(worst.h * m.dpr)} 设备像素，` +
      `只盖得住 ${thumbCoverage(worst, m).toFixed(2)}）—— 根因不是 DPR：.gallery-thumb 是` +
      '正方形框、按宽度铺，**吃的是缩略图的短边**，而 makeThumbnail 的 maxSide 限的是长边' +
      '（竖图 120x160 在 181 的框里就是 1.51x）。作品页那张要用 GALLERY_THUMB_MAX_SIDE' +
      '（src/core/thumbnail.ts），而调用点（App.tsx 的 saveOnce）必须**显式传**它 —— ' +
      '不传就回落到对话那张的 160，一声不吭。')
  }
}

// ── 2026-09-25 加（Task 12）：作品详情页 ────────────────────────────────
//
// 详情页是**同一个坑的第二次**：它是 `.shell` 的**直接子元素**，不在 `.app` 里 ——
// `.app` 那个 `overflow: hidden` 罩不到它，所以"自己滚"这条规则得自己写
// （`.detail` 的 `overflow-y: auto`）。
//
// 不自己滚的后果 Task 11 已经在作品页量到过：文档被滚 13762px、左栏 @top -13762
// （手机上整条导航划没了）。这不是"整页能滚就行"，是**左栏跟着一起走**。
//
// 判据**只有在真浏览器里才量得出来**：jsdom 没有排版引擎（getBoundingClientRect
// 一律 0）、`window.scrollY` 恒为 0，连"一页比一屏长"都表达不出来。
//
// 量四件事：**那张大图真的是原图、文档滚了 0px、左栏还在 @top 0、两栏配方都在屏内**
// （第四条是终审 C1 补的 —— 前三条对"详情页拿缩略图当大图"一条都不敏感）。

/** 量详情页现在长什么样。 */
async function measureDetail(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), bottom: Math.round(b.bottom),
      }
    }
    const d = document.querySelector('.detail')
    const boxes = [...document.querySelectorAll('.recipe-box')]
    return {
      name: document.querySelector('.detail-name')?.textContent ?? null,
      // ★ 详情页那张"大图"到底是**哪一张**：natural 尺寸就是接口回的那个文件的尺寸
      //   （CSS 缩放不影响它），所以"拿的是原图还是 160px 缩略图"直接量得出来。
      //   终审 C1：这条以前**根本没有**，而 seed 又把 `/thumb` 喂成了全尺寸图 ——
      //   两个洞叠起来，判据对"详情页把缩略图当大图"完全失明。
      image: (() => {
        const img = document.querySelector('.detail-image')
        if (!img) return null
        return {
          src: img.getAttribute('src'),
          naturalW: img.naturalWidth, naturalH: img.naturalHeight,
          w: Math.round(img.getBoundingClientRect().width),
          h: Math.round(img.getBoundingClientRect().height),
        }
      })(),
      // 两栏各自的盒子 top/bottom —— "挤到屏幕外"和"叠成一栏"都从这儿看得出来
      recipes: boxes.map(box),
      recipeTitles: boxes.map(b => b.querySelector('h3')?.textContent ?? ''),
      // 这一页**自己滚了多少**：滚轮滚过之后 > 0 = 它真的在自己滚
      scrolled: d ? Math.round(d.scrollTop) : null,
      docScroll: Math.round(window.scrollY),
      nav: box(document.querySelector('.nav')),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

/**
 * 判详情页的**版面**（和作品页那段同一个意思，只是页面换了一个）。
 *
 * ⚠️ `scrolled` 那一条是**判据自己的前提**，不是页面的性质：详情页要是根本没比
 * 一屏长，上面那几条（文档滚没滚、左栏在不在）全是白判的 —— 一个"从来不会红"的
 * 判据等于没有。真红了有两种可能（**看上面那条"文档被滚了"分清**）：要么这一页
 * 没有自己滚（滚轮滚的是整个文档），要么**夹具太短** —— 后一种要把 seed 进去的
 * 那张图放长，别去改判据。
 */
function judgeDetail(label, m, view) {
  console.log(`── ${label}`)
  console.log(`     名字 ${m.name ?? '（没有）'}   配方栏 ${m.recipeTitles.map(t => `「${t}」`).join(' ')}`)
  console.log(`     大图 ${m.image
    ? `${m.image.naturalW}x${m.image.naturalH} 自然 / ${m.image.w}x${m.image.h} 显示（${m.image.src}）`
    : '**不在 DOM 里**'}   原图长边应为 ${SEED_IMAGE_LONG}`)
  console.log(`     详情页自己滚了 ${m.scrolled}px，文档滚了 ${m.docScroll}px，` +
    `左栏 ${m.nav ? `${m.nav.w}x${m.nav.h} @top ${m.nav.top}` : '**不在 DOM 里**'}`)
  console.log('     两栏配方：' + (m.recipes.map(b => b
    ? `${b.w}x${b.h} @top ${b.top}~${b.bottom}`
    : '**不在 DOM 里**').join('   |   ')))

  // ★★ 那张"大图"必须是**原图本身**，不是 ≤160px 的缩略图（终审 C1）。
  //   为什么这条判据长这样：
  //     · 比**长边**（不是 `naturalWidth`）：seed 是 600x900 的竖图，只比宽的话
  //       正确的实现也会红；
  //     · 比 **natural** 尺寸（不是渲染尺寸）：`max-width: 100%; max-height: 60vh`
  //       会把它在屏幕上缩到一屏以内，渲染尺寸量不出"接口回的是哪张文件"；
  //     · 160 那道线是**真的分得开**的：缩略图 107x160、原图 600x900。
  //   ⚠️ 这条以前写的是 `naturalWidth > 0`（"有像素"）—— 而 seed 把 `/thumb`
  //   喂成同一张全尺寸图，于是它对 C1 那样的事**永远看不见**。判据和 seed 是
  //   同一个洞的两半，改一处没用。
  if (!m.image) {
    fails.push(`${label}：详情页上没有那张大图（.detail-image 不在 DOM 里）`)
  } else if (m.image.naturalW === 0) {
    fails.push(`${label}：详情页那张大图解不开（naturalWidth 是 0）—— 用户点进来只看到一块空白`)
  } else if (Math.max(m.image.naturalW, m.image.naturalH) < SEED_IMAGE_LONG) {
    fails.push(`${label}：详情页那张「大图」拿到的**不是原图**` +
      `（自然尺寸 ${m.image.naturalW}x${m.image.naturalH}，seed 原图的长边是 ${SEED_IMAGE_LONG}）` +
      ' —— §3.5 说的是"点开一张 → 看大图"，而这一页现在和列表上那张小图是同一种东西。' +
      '详情页的 .detail-image 和 .detail-download 两条都得走**原图**那条 URL（fullUrl），' +
      '拿缩略图顶上就是 C1：而"下载到我的电脑"是 §3.4 之后用户把原图拿出服务器的唯一一条路')
  }

  // ★ 两栏**永远是两栏**（§3.5.1）：数不到两个 = 谁把它们合成一个了
  if (m.recipes.length !== 2) {
    fails.push(`${label}：配方该是**两个**盒子（「调色」＋「用 AI 做的」），数到 ${m.recipes.length} 个 —— ` +
      '合成一个是骗人的：用户会以为"这一整套都能复用"（§3.5.1）')
  }
  for (const [i, b] of m.recipes.entries()) {
    if (!b) {
      fails.push(`${label}：第 ${i + 1} 栏配方不在 DOM 里`)
      continue
    }
    // ★ 两栏都得**完整落在视口里** —— 被挤到屏幕外就是把信息藏起来了
    if (b.top < -TOL || b.bottom > view.height + TOL) {
      fails.push(`${label}：第 ${i + 1} 栏配方没完整落在屏幕里` +
        `（@top ${b.top}~${b.bottom}，视口高 ${view.height}）`)
    }
  }
  // ★ 详情页必须自己滚：整页滚动的话左栏跟着走
  if (m.docScroll > TOL) {
    fails.push(`${label}：整个文档被滚了 ${m.docScroll}px —— 详情页该**自己滚**` +
      '（.detail 的 overflow-y: auto）；这样滚下去左栏会被划走，它的底色到一屏就断了')
  }
  if (!m.nav || m.nav.top < -TOL || m.nav.w < 40 || m.nav.h < 24) {
    fails.push(`${label}：左栏不在屏幕上了（${m.nav ? `${m.nav.w}x${m.nav.h} @top ${m.nav.top}` : '不在 DOM 里'}）`)
  }
  if (m.scrolled === null || m.scrolled <= TOL) {
    fails.push(`${label}：详情页一滚都没滚（scrollTop ${m.scrolled}）。两种可能，` +
      '看上面那条"文档被滚了"：要么它没有自己滚（.detail 的 overflow-y: auto 不在，' +
      '于是滚轮滚的是整个文档）；要么这一页没有比一屏长 —— 那上面那几条判据等于没判，' +
      '得把 seed 进去的那张图放长一点')
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
}

/**
 * 量「存失败之后」那一屏（Task 13，§6.6 ①）。
 *
 * **为什么要专门量**：那条失败路径上，用户改好的图**只在屏幕上** —— 一关页面
 * 就没了，而那一刻他要的是发朋友圈。横幅上那个「下载到电脑」是他唯一的出口，
 * 所以"它在不在屏幕上"是**真判据**：横幅就贴在顶栏下面，不该需要滚动才看得见。
 * （和 Task 11 那个"正在取…"的圈不一样：那个滚到底就是列表最后一个元素，
 * "在不在视野里"几乎恒为真，所以那边只量了"渲染出来了没有"。）
 *
 * **为什么纸面推演不出来**：横幅是一行 flex（`.ask, .save-fail`，带 flex-wrap），
 * 窄屏上换不换行、换行之后画布还剩多大，全是排版引擎的事 —— jsdom 一律返回 0。
 * 这个仓库在"溢出"这块栽过两次（作品页 `.gallery` 的 overflow-y、详情页 `.detail`），
 * 两次都是"真浏览器一量就红、纸面全绿"，所以这次不等它出事就先量。
 *
 * ⚠️ 这里**看不到**"被切掉"的话，量也白量：`.app` 是 `overflow: hidden`，
 * 横幅横向溢出去是**被切掉**的（不出滚动条、文档也不横向溢出）。所以判据是
 * **按钮自己的盒子在不在视口里**，不是"文档有没有横向滚动"。
 */
async function measureSaveFail(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const bar = document.querySelector('.save-fail')
    /** 一个盒子上的字排成了几行 —— `Range.getClientRects()` 每个行盒给一个矩形。
     *  为什么要量这个：`.save-fail` 是一行 flex，**去掉 `flex-wrap` 并不会横向溢出**
     *  （实测：flex 项会缩，中文句子的 min-content 只有一个字宽）—— 真正发生的是
     *  那两个按钮被**挤扁**：「下载到电脑」从 100x35 变成 65x77，字在按钮里折成三行。
     *  不出滚动条、不溢出、盒子也还在视口里，量盒子尺寸那一套一条都看不见它。 */
    const lines = el => {
      const r = document.createRange()
      r.selectNodeContents(el)
      return [...r.getClientRects()].filter(x => x.width > 0 && x.height > 0).length
    }
    return {
      bar: box(bar),
      // 按**类名**找（结构），和测试那边同一个锚点：文案只留给文案断言
      dl: box(bar?.querySelector('button.download') ?? null),
      // 横幅里**每个**按钮：字排成几行、盒子多大
      btns: [...(bar?.querySelectorAll('button') ?? [])].map(b => ({
        text: (b.textContent ?? '').trim().slice(0, 12),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
        lines: lines(b),
      })),
      barText: (bar?.textContent ?? '').slice(0, 60),
      scrolled: Math.round(window.scrollY),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  })
}

const inViewport = (b, view) =>
  b.left >= -TOL && b.top >= -TOL && b.right <= view.width + TOL && b.bottom <= view.height + TOL

function judgeSaveFail(label, m, view) {
  console.log(`── ${label}`)
  console.log(`     横幅 ${m.bar ? `${m.bar.w}x${m.bar.h} @${m.bar.left},${m.bar.top}` : '不在 DOM 里'}` +
    `   下载按钮 ${m.dl ? `${m.dl.w}x${m.dl.h} @${m.dl.left},${m.dl.top}` : '不在 DOM 里'}` +
    `   文档滚动 ${m.scrolled}px，横向 ${m.scrollW}/${m.clientW}`)
  console.log(`     横幅里的按钮 ${m.btns.map(b => `「${b.text}」${b.w}x${b.h}·${b.lines}行`).join('  ') || '（一个都没有）'}`)
  // 印出来只是给人看的（这一条量的是版面，文案归 App.test.tsx 那几条断言管）
  console.log(`     横幅上说：「${m.barText}」`)
  if (!m.bar || m.bar.w <= 0 || m.bar.h <= 0) {
    fails.push(`${label}：存不进去的那一刻，屏幕上**没有**那条横幅 —— 用户既不知道出了什么事，` +
      '也拿不到那张只在屏幕上的图（§6.6 ①，§10 点名"最容易漏"的就是这个按钮）')
    return
  }
  if (!inViewport(m.bar, view)) {
    fails.push(`${label}：横幅没有完整落在视口里（${m.bar.w}x${m.bar.h} @${m.bar.left},${m.bar.top}，` +
      `视口 ${view.width}x${view.height}）—— 它就在顶栏旁边，不该需要滚动才看得全`)
  }
  if (!m.dl || m.dl.w <= 0 || m.dl.h <= 0) {
    fails.push(`${label}：横幅上没有那个「下载到电脑」按钮（.save-fail button.download）—— ` +
      '那一屏上它是用户唯一能拿到图的出口，没有它这张图就真的没了')
    return
  }
  if (!inViewport(m.dl, view)) {
    fails.push(`${label}：那个「下载到电脑」按钮没有完整落在视口里` +
      `（${m.dl.w}x${m.dl.h} @${m.dl.left},${m.dl.top}，视口 ${view.width}x${view.height}）—— ` +
      '用户手指够不到的地方，等于没有这个按钮（横幅横向溢出时是**被 .app 悄悄切掉**的，' +
      '不看这个盒子看不出来）')
  }
  if (m.scrollW > m.clientW) {
    fails.push(`${label}：页面横向溢出，要左右滑（${m.scrollW} > ${m.clientW}）`)
  }
  // ★ 按钮上的字必须**各自顶在一行**上。这一条是**量出来的**，不是推出来的：
  //   把 `.save-fail` 的 `flex-wrap: wrap` 去掉之后，横向**不会**溢出（中文句子的
  //   min-content 只有一个字宽，flex 项缩得下去），文档也还是 390/390 —— 真正
  //   发生的是那个按钮被挤扁（100x35 → 65x77，字折成三行），上面每一条判据都绿。
  //   而按钮被挤扁正是"该换行的是横幅、不是按钮里的字"这件事被弄丢的样子。
  for (const b of m.btns) {
    if (b.lines > 1) {
      fails.push(`${label}：横幅里「${b.text}」那个按钮被挤扁了 —— 它上面的字排成了 ${b.lines} 行` +
        `（按钮只剩 ${b.w}x${b.h}）。该换行的是**横幅**（.save-fail 的 flex-wrap: wrap），` +
        '不是按钮里的字：用户要一眼认出"按这个就能拿到图"，字折成三行就不像按钮了')
    }
  }
}

// ── 2026-09-30 加：上传前那一屏（`.welcome`）─────────────────────────────
/**
 * 为什么补这一段：**上面每一条判据都是"传完照片之后"的** —— 而这一屏是
 * 登录之后看到的**第一张脸**，在这之前它一次都没被量过（`.welcome` 只在
 * `!image` 时渲染，而这条检查登录完就直接 `setInputFiles` 过去了）。
 *
 * ★ 2026-09-30 当时它是为了一句新文案加的（「一天大概能改二十来张照片。」——
 *   `.welcome-note`）：而 `.app` 是 **overflow: hidden**，这一列比 `.stage` 高的话，
 *   超出去的部分是被**静静地切掉**的（不出滚动条、不横向溢出、别的判据全绿）。
 *   上面那条"画布必须完整落在视口里"就是同一个病在修图页的样子 —— 这里是首屏的样子。
 *
 * ★ 2026-10-03：那句话连同三个示范句被用户拿掉了（「这些全都不要」），
 *   于是第二、三条判据（那句话在不在、说没说"多少张"）跟着撤。
 *   **留下的一条反而更重要**：这一屏现在矮了一截，但它是"往里加东西会不会被切"
 *   的唯一哨兵 —— 哪天有人再往 `.welcome` 里塞东西，这里会红。
 */
async function measureWelcome(page) {
  return page.evaluate(() => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    return { welcome: box(document.querySelector('.welcome')) }
  })
}

function judgeWelcome(label, m, view) {
  console.log(`── ${label}`)
  console.log(`     上传前那一屏 ${m.welcome ? `${m.welcome.w}x${m.welcome.h} @${m.welcome.left},${m.welcome.top}` : '不在 DOM 里'}`)
  if (!m.welcome) { fails.push(`${label}：找不到 .welcome —— 上传前那一屏整个不见了`); return }
  if (m.welcome.top < -TOL || m.welcome.bottom > view.height + TOL) {
    fails.push(`${label}：上传前那一屏没完整落在视口里（${m.welcome.h}px 高 @${m.welcome.top}，` +
      `视口 ${view.height}）—— .app 是 overflow: hidden，超出去的是被切掉的，` +
      '用户看到的是"少了半截"，而别的判据一条都不会红')
  }
}

// ── 2026-10-01 加（Task 6）：左栏「对话」那一页 ─────────────────────────
/**
 * 为什么补这一段：**新页面一出生就必须被量过**，否则它没有任何版面检查。
 * 更坏的是探针会**静默腐烂** —— 选择器和网址会随产品改名而烂掉，而且一声不吭
 * （文件开头那条教训就是为这个写的）。
 *
 * 三态都要量，因为它们挤的程度不一样：
 *   · **空态**（刚注册、一条会话都没有）：只有一句话和一颗按钮。它是新用户点进
 *     「对话」看到的**第一眼**；
 *   · **列表**：一行里塞着"缩略图 + 名字 + 几步 + 删除"。390px 的手机上去掉左栏
 *     （92px）和页面留白，剩不到 250px —— **全站最挤的一行就是它**；
 *   · **就地确认**（按了「删除」）：又多出一句问话和两颗按钮。这一态的设计是
 *     "这一行换了个问题问"（照片和名字让位），**那个让步只有在窄屏上量过才算数**。
 *
 * 判据每一条都能说出错了会怎样：
 *   ① 这一页真的在（`.sessions`）—— 网址或选择器腐烂的第一现场；
 *   ② **横向不溢出**：一行撑破会顶出一根横向滚动条，而 `.shell` 是锁死一屏的，
 *      整页会左右滑；
 *   ③ 该看得见的东西**完整落在视口里**（行、缩略图、问句、两颗按钮）；
 *   ④ 缩略图是个**方块**（`.session-thumb` 定死了宽高）—— 不定的后果不是难看，
 *      是每张图跳出来都把后面的行推一下；
 *   ⑤ 左栏三支 = 「修图 / 对话 / 作品」（§6.1），而且亮的是「对话」。
 *      ⚠️ 顺带钉住"这一页有没有自己的入口"：Task 6 之前它**根本没有来源**。
 *   ⑥ ★ 2026-10-03：左栏底下那**两颗**（「首页」回门面、「个人设置」= 用户管理）
 *      在，而且**推到边上、和上面三支隔开** —— 它们不是第四、第五支，
 *      见下面 `homeBox` / `meBox` 那一段。
 */
async function measureSessions(page, targetName = null) {
  return page.evaluate((want) => {
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), left: Math.round(b.left),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const rows = [...document.querySelectorAll('.session-row')]
    const thumbs = [...document.querySelectorAll('.session-thumb')]
    // ★ 2026-10-01：可以**点名量某一行**（长名字那一段用）。
    //   为什么非点名不可：列表是按 `updated_at` 倒序给的，而这个 App **自己**会写
    //   —— 换页/关页面那一刻，还没到点的那趟落盘会被发出去（2026-10-01 I1 的修复，
    //   那是**正确行为**），那一下会把**另一条**会话的时间戳顶上来，探针刚种下的
    //   那条就不在第一行了。原来这段判据假定"我种下的必然是第一行"，于是它量的
    //   东西会**悄悄换成别人**，红的时候只说"没量到它要量的东西" —— 量谁、由谁
    //   决定，这里说清楚。点名之后，量的一直是它（找不到才按"没量到"报）。
    const row = want
      ? rows.find(r => (r.querySelector('.session-name')?.textContent ?? '').trim() === want) ?? null
      : rows[0]
    const name = row ? row.querySelector('.session-name') : null
    const thumb = row ? row.querySelector('.session-thumb') : null
    const ask = document.querySelector('.session-ask')
    // ★ 量的是**正在确认的那一行**里的按钮，不是整页的 `.session-del`
    //   （2026-10-01 评审抓到的第二个洞：原来挑的是整页，页上一旦有两行，
    //   `dels.length` 就不是 2，下面那条颜色判据会**静默跳过** ——
    //   看起来在守，其实没守）。
    const confirming = document.querySelector('.session-row.confirming')
    const dels = confirming ? [...confirming.querySelectorAll('.session-del')] : []
    return {
      onPage: !!document.querySelector('.sessions'),
      nav: [...document.querySelectorAll('.nav button:not(.nav-home):not(.nav-me)')]
        .map(b => b.textContent.trim()),
      navOn: document.querySelector('.nav-item.on')?.textContent?.trim() ?? '',
      // ★ 2026-10-03：左栏底下那**两颗**（「首页」回门面、「个人设置」= 用户管理，
      //   见 Nav.tsx）**单独量** —— 它们不是第四、第五支，所以上面那三支照旧按
      //   "只有三支"守，这一组自己管"在不在、推没推到边上、和那三支隔开没有"。
      //   ⚠️ auto 外边距挂在组里的**第一颗**（`.nav-home`）身上，所以：
      //   "贴边"要看组里**最后一颗**（`.nav-me`），"隔开"要看**第一颗**离三支多远。
      // ⚠️ 窄屏上左栏是**横排**（styles.css 的 `@media (max-width: 640px)`），
      //   所以"推到边上"在那边是**最右**、不是最底下 —— `navRow` 就是给判据
      //   分轴用的，见 judgeSessions 里那一段。
      navRow: getComputedStyle(document.querySelector('.nav')).flexDirection === 'row',
      homeBox: box(document.querySelector('.nav-home')),
      meText: document.querySelector('.nav-me')?.textContent?.trim() ?? '',
      meBox: box(document.querySelector('.nav-me')),
      lastTabBox: (() => {
        const tabs = [...document.querySelectorAll('.nav button:not(.nav-home):not(.nav-me)')]
        return box(tabs[tabs.length - 1])
      })(),
      navBox: box(document.querySelector('.nav')),
      rows: rows.length,
      emptyTitle: document.querySelector('.sessions-empty-title')?.textContent?.trim() ?? '',
      goBtn: box(document.querySelector('.sessions-empty button')),
      dayTitle: document.querySelector('.gallery-day-title')?.textContent?.trim() ?? '',
      // 点名那一段：这一行是**按名字找的**，不是"第一行"（见上面那段理由）
      targeted: !!want,
      row: box(row),
      thumb: box(thumb),
      thumbsOk: thumbs.filter(i => i.naturalWidth > 0).length,
      name: name ? name.textContent.trim() : '',
      nameBox: box(name),
      // 名字被截断了没有（`scrollWidth > clientWidth` 就是那个省略号真的生效了）。
      // **截断本身是对的** —— 要的是"它只在自己的格子里截，没把整行顶出去"。
      nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
      askText: ask ? ask.textContent.trim() : '',
      askBox: box(ask),
      dels: dels.map(b => b.textContent.trim()),
      delBoxes: dels.map(b => box(b)),
      // ★ 确认态那两颗按钮的**颜色**（2026-10-01 加，同日评审后重做）：
      //   「删掉」和「取消」只差一个字，点错一次东西就没了 —— 颜色是它们唯一的区别。
      //   ⚠️ 第一版有**两个洞**（评审拆出来的，都补了）：
      //     ① 量到的是**悬停态**：驱动那边刚点过「删除」，鼠标就停在原地 ——
      //        而确认态里最右边那颗是「取消」。悬停态两颗颜色天生不同，
      //        于是"把修复撤掉"它照样绿（对**原始那份 CSS** 跑也是绿的）。
      //        现在驱动先 `mouse.move(0, 0)`，这里另外把"量到的按钮正被悬停"
      //        报成失败（`delHovered`）—— 悬停态不算数。
      //     ② 挑的是整页的 `.session-del`，页上一有两行条数就不是 2，
      //        判据会静默跳过。现在只挑**正在确认那一行**的（见上面 `dels`）。
      delColors: dels.map(b => getComputedStyle(b).color),
      delHovered: dels.map(b => b.matches(':hover')),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }
  }, targetName)
}

/** 左栏三支的顺序（§6.1）：修图是主入口，对话在中间，作品最后。 */
const NAV_THREE = ['修图', '对话', '作品']

function judgeSessions(label, m, view, mode) {
  console.log(`── ${label}`)
  console.log(`     左栏 ${m.nav.join(' / ')}（亮的是「${m.navOn}」）` +
    (m.homeBox && m.navBox && m.meBox
      ? `　尾部那两颗「首页 / ${m.meText}」${m.navRow ? '贴右' : '贴底'} ` +
        `${m.meBox[m.navRow ? 'right' : 'bottom']}/${m.navBox[m.navRow ? 'right' : 'bottom']}` +
        `　隔上面三支 ${m.lastTabBox
          ? (m.navRow ? m.homeBox.left - m.lastTabBox.right : m.homeBox.top - m.lastTabBox.bottom)
          : '?'}px`
      : '　**左栏尾部那两颗不在 DOM 里**'))
  if (mode === 'empty') {
    console.log(`     空态「${m.emptyTitle}」 ` +
      `按钮 ${m.goBtn ? `${m.goBtn.w}x${m.goBtn.h} @${m.goBtn.top}` : '不在'}`)
  } else {
    console.log(`     ${m.rows} 行；第一行 ${m.row ? `${m.row.w}x${m.row.h} @${m.row.left}~${m.row.right}` : '不在'}；` +
      `缩略图 ${m.thumb ? `${m.thumb.w}x${m.thumb.h}` : '不在'}（解开 ${m.thumbsOk} 张）；` +
      `名字「${m.name}」${m.nameClipped ? '（截断了，这是对的）' : ''}` +
      `；分组标题「${m.dayTitle}」`)
    if (m.askText) {
      console.log(`     确认态「${m.askText}」 按钮 ${m.dels.join(' / ')} ` +
        `@${m.delBoxes.map(b => (b ? `${b.left}~${b.right}` : '不在')).join(' , ')}` +
        `；颜色 ${m.dels.map((t, i) => `${t} ${m.delColors[i]}`).join(' / ')}`)
    }
  }

  const inView = b => !!b && b.top >= -TOL && b.bottom <= view.height + TOL &&
    b.left >= -TOL && b.right <= view.width + TOL

  if (!m.onPage) {
    fails.push(`${label}：找不到 .sessions —— 「对话」这一页整个不在 ` +
      '（网址改了？组件改名了？探针烂掉的时候就是这个形状）')
    return
  }
  if (m.nav.join('/') !== NAV_THREE.join('/')) {
    fails.push(`${label}：左栏是「${m.nav.join(' / ')}」——` +
      `§6.1 要的是「${NAV_THREE.join(' / ')}」三支，顺序也是这个`)
  }
  // ★ 2026-10-03：左栏底下那**两颗**（「首页」= 回门面、「个人设置」= 用户管理）
  //   在不在、**推没推到边上**、**和上面三支隔开没有**。
  //   位置这条只能在这儿守 —— vitest 没有排版引擎，`.nav-home` 那两条 auto
  //   外边距被谁删掉的话那边一条都不会红，而这两颗会**悄悄**变成和「作品」
  //   挤在一起的第四、第五支（用户看不出它们是"出门"和"设置"，只当又两个栏目）。
  //   ⚠️ 判据**分横竖两种**：手机上左栏收成了横排，那边推的是**最右**。
  //      只按"最底下"判的话，手机那几档会**假绿**（横排里 item 的底边本来就
  //      贴着横条的底）—— 实测过：把手机上那条规则删掉，只按纵轴判，它一声不吭。
  //   实测贴边后离容器边 10~12px（内边距），两个方向都留 40px 的余量。
  //
  //   ★ 2026-10-03 傍晚（「个人设置」搬进来之后）拆成两条：
  //     ① **组贴边** —— 量组里**最后一颗**（`.nav-me`）：auto 外边距挂在「首页」
  //        身上，但它推的是整组，所以贴边要看尾巴；
  //     ② **和上面三支隔开** —— 量组里**第一颗**（`homeBox`）和三支里最后那颗
  //        （`lastTabBox`）之间空多远。这条才是真正的闸：把 auto 外边距删掉时，
  //        ①可能还碰巧过（这一组本来就在末尾），②当场就红。
  if (!m.homeBox || !m.meBox || !m.navBox || !m.lastTabBox) {
    fails.push(`${label}：左栏尾部那两颗（「首页」/「个人设置」）不在 —— ` +
      '回门面的路、或者用户管理那一页的入口又断了')
  } else {
    const axis = m.navRow ? 'right' : 'bottom'
    const 离边 = m.navBox[axis] - m.meBox[axis]
    if (离边 > 40) {
      fails.push(`${label}：左栏尾部那两颗没推到${m.navRow ? '最右边' : '最底下'}` +
        `（离容器边 ${离边}px，左栏 ${m.navBox.w}x${m.navBox.h}${m.navRow ? '（横排）' : ''}）` +
        '—— 它们会和上面三支挤在一起，被看成"第四支导航"')
    }
    const 空隙 = m.navRow
      ? m.homeBox.left - m.lastTabBox.right
      : m.homeBox.top - m.lastTabBox.bottom
    // 门槛取 20：三支之间**正常**的间隙就是 `--sp-1`（4px）上下，而这里实测
    // 390px 宽时只有 40px（这一行本来就挤，320px 的小屏上会缩到几乎贴着）——
    // 所以别拿 40 当门槛，那样"刚好不红"全看运气。20 已经足够说明
    // "那句 auto 外边距还在干活"（它被删掉时这里是 4px）。
    if (空隙 < 20) {
      fails.push(`${label}：左栏尾部那两颗贴着上面三支（只隔 ${空隙}px，` +
        `${m.navRow ? '横排' : '竖列'}）—— 那句 auto 外边距被删了？` +
        '它们看上去就变成第四、第五个栏目了')
    }
    if (m.meText !== '个人设置') {
      fails.push(`${label}：左栏尾部那颗写的是「${m.meText}」而不是「个人设置」—— ` +
        '用户管理那一页的入口（2026-10-03 从顶栏右上角那颗 👤 搬下来的）')
    }
  }
  if (m.navOn !== '对话') {
    fails.push(`${label}：人站在对话页上，左栏亮的却是「${m.navOn}」`)
  }
  if (m.scrollW > m.clientW + TOL) {
    fails.push(`${label}：横向溢出（文档 ${m.scrollW} > 视口 ${m.clientW}）—— ` +
      '一行撑破了，整页要左右滑，而 .shell 是锁死一屏的')
  }

  if (mode === 'empty') {
    if (!m.emptyTitle) {
      fails.push(`${label}：空态里没有那句「还没改过照片」（.sessions-empty-title）`)
    }
    if (!m.goBtn) {
      fails.push(`${label}：空态里没有那颗「去改一张」—— 用户看到"还没改过照片"之后没有下一步`)
    } else if (!inView(m.goBtn)) {
      fails.push(`${label}：那颗「去改一张」没落在视口里（@${m.goBtn.top}~${m.goBtn.bottom}，` +
        `视口 ${view.height}）—— 写了却看不见，等于没写`)
    }
    return
  }

  if (m.rows < 1) {
    fails.push(`${label}：一行都没摆出来（服务端上明明有会话）—— 名单没渲染`)
    return
  }
  if (!inView(m.row)) {
    fails.push(`${label}：${m.targeted ? '点名那一行' : '第一行'}没完整落在视口里` +
      `（${m.row ? `${m.row.left}~${m.row.right} / ${m.row.top}~${m.row.bottom}` : '不在 DOM 里'}，` +
      `视口 ${view.width}x${view.height}）`)
  }
  if (!m.thumb) {
    fails.push(`${label}：行上没有缩略图（.session-thumb）`)
  } else if (m.thumb.w !== m.thumb.h) {
    fails.push(`${label}：缩略图不是个方块（${m.thumb.w}x${m.thumb.h}）——` +
      '尺寸不定的后果不是难看：每张图跳出来都会把后面的行推一下')
  }
  if (m.thumbsOk === 0) {
    fails.push(`${label}：一张缩略图都没解开（naturalWidth 全是 0）—— 列表上那些图根本没取到`)
  }
  if (!m.name) {
    fails.push(`${label}：行上没有名字（.session-name 是空的）`)
  }
  // ⚠️ **名字只许在自己的格子里截**（`min-width: 0` + 省略号那一条）：
  //   盒子右边缘越过整行 = 它把行顶出去了。窄屏上这事儿看不出来 ——
  //   它表现为"整页多出一根横向滚动条"，而那是另一条判据在喊。
  if (m.nameBox && m.row && m.nameBox.right > m.row.right + TOL) {
    fails.push(`${label}：名字那一格顶出了整行` +
      `（名字右 ${m.nameBox.right} > 行右 ${m.row.right}）—— 长名字把行撑破了`)
  }
  if (!/·\s*\d+\s*条$/.test(m.dayTitle)) {
    fails.push(`${label}：列表上没有按天分组的那行标题（现在读到的是「${m.dayTitle}」）——` +
      '它是和作品页共用的那一套（groupByDay），两页必须一起长这样')
  }

  if (mode === 'confirm') {
    if (!m.askText) {
      fails.push(`${label}：按了「删除」却没有就地确认那句（.session-ask）——` +
        '用户不知道自己刚才按了什么（这一版明确说好**不弹系统框**）')
    } else if (!inView(m.askBox)) {
      fails.push(`${label}：那句「${m.askText}」没落在视口里（@${m.askBox.left}~${m.askBox.right}）`)
    }
    // 确认态的两颗按钮（「删掉」「取消」）：点错一次东西就没了，所以它们在不在屏上
    // 是**真判据**，不是排版洁癖。
    m.delBoxes.forEach((b, i) => {
      if (!inView(b)) {
        fails.push(`${label}：确认态第 ${i + 1} 颗按钮（「${m.dels[i]}」）没完整落在视口里` +
          `（${b ? `${b.left}~${b.right}` : '不在 DOM 里'}）`)
      }
    })
    // ★ 两颗按钮**长得必须不一样**：它们只差一个字（「删掉」/「取消」），
    //   而按错一次东西就没了 —— 颜色是唯一把危险那颗标出来的东西。
    //   ⚠️ 这条判据是 2026-10-01 补的，补的是一个**已经发生过的洞**：
    //   `.session-del:first-of-type` 按标签名算，第一个 `button` 兄弟是
    //   `display:none` 的 `.session-open` —— 那条规则一次都没生效过，
    //   「删掉」和「取消」一个色。当时探针只量几何（都在视口里 ✔）、
    //   测试按**文字**找按钮（也 ✔）、typecheck 更是看不见 CSS 的死活，
    //   于是它安安静静烂在那儿，直到人用眼睛看了一遍才发现。
    //
    //   ⚠️⚠️ 同一天的评审把这条判据**又拆了一遍** —— 第一版会**静默跳过**
    //   （挑的是整页的 `.session-del`，页上多一行就不是 2 颗）、而且量到的是
    //   **悬停态**（鼠标点完「删除」停在原位，确认态里那个位置是「取消」）——
    //   悬停态两颗天生不同色，于是"把修复撤掉"它照样绿。所以下面先钉住
    //   "这一行里就是那两颗、名字对得上、而且没被悬停"，再比颜色：
    //   **每一步不成立都报失败，不跳过**。
    const wantDels = ['删掉', '取消']
    if (m.dels.length !== 2 || m.dels[0] !== wantDels[0] || m.dels[1] !== wantDels[1]) {
      fails.push(`${label}：确认态那一行应该有「删掉」「取消」两颗按钮，实际读到 ` +
        `${m.dels.length} 颗${m.dels.length ? `（${m.dels.join(' / ')}）` : ''} —— ` +
        '挑不到它们，下面的颜色判据就是在空气上比（第一版还会**静默跳过**：' +
        '它只比"两颗颜色一样不一样"，挑不到就什么都不说）。')
    } else if (m.delHovered.some(Boolean)) {
      fails.push(`${label}：量那两颗按钮颜色的时候，鼠标**还停在按钮上**（读到的是悬停态）—— ` +
        '悬停态两颗颜色天生不同，拿它当判据等于没量。驱动按完「删除」要先 ' +
        '`page.mouse.move(0, 0)` 把指针挪开再量。')
    } else if (m.delColors[0] === m.delColors[1]) {
      fails.push(`${label}：确认态那两颗按钮**是同一个颜色**（${m.delColors[0]}）——` +
        '「删掉」和「取消」只差一个字，颜色再一样就等于没标出哪颗是危险的那个。' +
        '（多半是选择器又按位置挑了：`.session-open` 虽然 `display:none`，' +
        '它的 `button` 标签还在，`:first-of-type` 之类选不中「删掉」。' +
        '要挑它就用它自己的类 `.session-del.danger`。）')
    }
  }
}

console.log(`── 量的是 ${URL}`)
console.log(`   ${await checkServedBuild()}`)

const browser = await chromium.launch()
try {
  for (const view of VIEWS) {
    const page = await browser.newPage({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: view.deviceScaleFactor, isMobile: view.isMobile, hasTouch: view.hasTouch,
    })
    try {
      // 这一路会真调模型（花钱），而且它跟版面无关。必须掐掉。
      await page.route('**/api/suggest', r => r.abort())
      // 这一路**是真花钱的**（一次生成约 12,900 tokens）。点选这条路今天走不到它
      // （我们只走到"点了一下、还没点确认"），但真要走到了就是出事了 ——
      // 掐掉它，并且下面数着它有没有被请求过（数到了就是检查自己出了错）。
      await page.route('**/api/edit', r => r.abort())
      // 路由那条**用假造的响应 fulfill**：真调 /api/route 要花钱。
      // 只替换响应，不碰真模型。
      await page.route('**/api/route', r => r.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_DECISION),
      }))
      // ★ 存失败那一段（Task 13，§6.6 ①）要的那条 413：**真服务器造不出来**。
      //   它只在**单张图超过 8 MB** 时才 413（server/works.ts 的 MAX_WORK_BYTES），
      //   而这条检查用的样片离那个数差得远 —— 这段要量的又恰恰是"存不进去之后
      //   那一屏"，所以拦下来自己回一个（形状照抄服务端那条
      //   HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)）。
      //   ⚠️ **只在 `saveFails` 打开的那一小段里拦**：下面「放作品」用的也是
      //      POST /api/works（page.evaluate 里直接 fetch），拦穿过去的话作品页
      //      那一段会没有数据 —— 而它会红在**别的**判据上，看不出是这个原因。
      let saveFails = false
      await page.route('**/api/works', (r) => {
        if (!saveFails || r.request().method() !== 'POST') return r.continue()
        return r.fulfill({
          status: 413, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'BAD_REQUEST', message: '这张图太大了，存不下' } }),
        })
      })
      const editCalls = []
      page.on('request', r => { if (r.url().includes('/api/edit')) editCalls.push(r.url()) })

      // **假装这台设备支持分享。** 真实的无头 Chromium 不支持，于是顶栏只有
      // 两个按钮 —— 那是宽松的那一侧，量它等于没量。分享按钮出来之后是三个，
      // 那才是会挤爆的那一侧。**每一档都要带上它**，否则量的是宽松的那一侧。
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'canShare', {
          value: d => !!(d && d.files && d.files.length), configurable: true,
        })
        Object.defineProperty(navigator, 'share', {
          value: async () => {}, configurable: true,
        })
      })

      try {
        await page.goto(APP, { waitUntil: 'load' })
      } catch {
        console.log(`❌ 连不上 ${URL} —— dev 服务器开着吗？（npm run dev）`)
        process.exitCode = 1
        process.exit()
      }

      // ── 2026-09-25 加：先登录，再量 ────────────────────────────────────
      // **为什么要先登录**：Task 7 加了前端登录页之后，修图界面在**登录墙**后面 ——
      // 打开页面看到的是登录页，`input[type="file"]` 根本不在 DOM 里。这条检查原来
      // 不认这回事，于是它红在 `page.setInputFiles: Timeout`（2026-09-25 发现）。
      // 探针验过那是**检查缺一步**、不是版面坏了：补上登录之后两档两态的判据数字一条没变。
      //
      // **用哪个账号**（2026-09-25 的裁定）：每次现注册一个随机名字的临时账号。
      //   · 不在脚本里写死任何凭据 —— 写死等于要在仓库里留一份"测试账号"，还得有人手工建它；
      //   · 名字带随机后缀，不会和别的账号撞（撞了会 400，检查就会莫名其妙地红）；
      //   · 库是 dev 的、`data/` 已 gitignore。这条检查本来就是"起一个干净环境量版面"，
      //     自己造一个用户完全在它的职责范围内。
      // **走 fetch 而不是去点登录页的表单**：这条检查量的是版面，不该因为登录页换了
      // 一个 class 名就整体变红 —— 那是登录页自己的检查该管的事。
      await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
      if (await page.locator('.login-box').count()) {
        const who = `布局检查${Date.now().toString(36)}`
        const status = await page.evaluate(async (who) => {
          const r = await fetch('/api/signup', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: who, email: `${who}@example.com`, password: 'layout-check-only' }),
          })
          return r.status
        }, who)
        if (status !== 200) {
          console.log(`❌ 登录墙后面进不去：现注册临时账号「${who}」返回了 HTTP ${status}`)
          process.exitCode = 1
          process.exit()
        }
        console.log(`   登录墙：现注册了临时账号「${who}」（dev 库，已 gitignore）`)
        await page.reload({ waitUntil: 'load' })
      }
      // 那个 input 是**隐藏**的（`.uploader` 把它藏起来、由 label 当按钮用），
      // 所以这里要 `state: 'attached'` —— 默认的"要可见"会一直等到超时。
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15_000 })

      // ★ 趁照片还没传、`.welcome` 还在，先量它 —— 传完它就没了。
      await page.waitForTimeout(400)   // 让那条进场动画走完（.welcome 是 translateY 进来的）
      judgeWelcome(`${view.name} · 上传前那一屏`, await measureWelcome(page), view)

      // ── 对话页 · 空态（Task 6）──────────────────────────────────────
      // 趁这个账号**一条会话都没有**（照片还没传）—— 那是新用户点进「对话」看到
      // 的第一眼。等传完照片这里就永远至少有一条了，所以只有这一个窗口量得到它。
      await page.goto(`${APP}/sessions`, { waitUntil: 'load' })
      await page.waitForSelector('.sessions', { timeout: 15_000 })
      await page.waitForTimeout(300)   // 让进场动画走完（空态是 translateY 进来的）
      judgeSessions(`${view.name} · 对话页（一条都没有）`, await measureSessions(page), view, 'empty')

      // 回修图页接着走原来那一路（下面要传照片）
      await page.goto(APP, { waitUntil: 'load' })
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15_000 })

      await page.setInputFiles('input[type="file"]', PHOTO)
      await page.waitForSelector('canvas', { timeout: 15_000 })
      await page.waitForTimeout(1200)
      judge(`${view.name} · 刚传完照片`, await measure(page), view)
      // 真的 makeThumbnail 的产出：能解开、真有像素。（jsdom 那条路整个把它假掉了。）
      await judgeThumb(page, `${view.name} · 刚传完照片`)

      // ── 图上点选：红圈的几何 ─────────────────────────────────────────
      // 走到的位置是"用户点了一下、还没点确认" —— 钱就卡在这一步之后，
      // 所以这一段**一个付费调用都没有**（route 是假造的，suggest/edit 掐掉了）。
      await page.fill('input[name="text"]', '把后面那个人去掉')
      await page.press('input[name="text"]', 'Enter')
      // 「不用了」出现 = 进入了点选模式（假造的路由决策说"拿不准"）
      await page.getByRole('button', { name: '不用了' }).waitFor({ timeout: 10_000 })

      // 点一个**已知屏幕坐标**：画布盒子的 20% / 35% 处（为什么不取正中见 PICK_AT）。
      const at = await canvasRect(page)
      const clickX = at.left + PICK_AT.fx * at.width
      const clickY = at.top + PICK_AT.fy * at.height
      await page.mouse.click(clickX, clickY)
      await page.waitForSelector('.canvas-marker', { timeout: 5_000 })
      judgeMarker(`${view.name} · 在图上点了一下`, await measurePick(page),
        { x: clickX, y: clickY })

      // 开调色面板之后版面会变（画布被缩放）—— 圈必须还钉在**照片上的同一个点**。
      // 窄屏这一档更狠：面板一开，对话栏整个 `display: none`（所以点选只能在这
      // 之前发起），而画布要跟着缩放，圈不能跟着飘。
      await page.getByRole('button', { name: '调色' }).click()
      await page.waitForTimeout(500)
      judgeMarker(`${view.name} · 开着调色面板，圈还得钉在照片上`, await measurePick(page), null)
      judge(`${view.name} · 打开调色面板后`, await measure(page), view)

      // 一路走下来，花钱的那条路一次都不该被碰过。
      if (editCalls.length > 0) {
        fails.push(`${view.name}：点选这条路上竟然发出了 ${editCalls.length} 次 /api/edit ——` +
          '那是花钱的（一次约 12,900 tokens），而用户还没点「就改这里」')
      }

      // ── 存失败（Task 13，§6.6 ①）────────────────────────────────────
      //
      // 为了量这一屏，刚才把那个 413 写进了 `saveFails`（见上面 route 那段注释）。
      //
      // **量的是哪一屏**：用户按了「保存」→ 存不进去 → 横幅出现。这一屏上
      // 他手里那张改好的图**只在屏幕上**，横幅上那个「下载到电脑」是唯一的出口
      // —— 所以"它完整在不在视口里"是**真判据**（见 measureSaveFail 那段）。
      //
      // **放在这里的原因**：① 照片、对话、画布都在（前面那一趟没动过它们）；
      //   ② 面板要**先关掉** —— 窄屏上开着面板时对话栏是 `display: none`，
      //   量的会是"面板开着的那一屏"，而那多半是最宽松的一档；
      //   ③ **必须在作品页那一段之前** —— 那一段也要 POST /api/works（放作品），
      //   两条路是同一个地址，靠 `saveFails` 这个开关分开。
      await page.getByRole('button', { name: '调色' }).click()   // 收掉面板
      await page.waitForTimeout(300)
      saveFails = true
      await page.getByRole('button', { name: '保存' }).click()
      // ⚠️ 等横幅**出现**再量：量"点了、还没回来"的那一屏等于什么都没量
      await page.waitForSelector('.save-fail', { timeout: 15_000 })
      await page.waitForTimeout(300)          // 让排版落定（换行、滚动条）
      judgeSaveFail(`${view.name} · 存失败之后`, await measureSaveFail(page), view)
      // 画布那几条一起判：横幅把工作区压矮了，而"照片还看得见"正是这一段的前提
      judge(`${view.name} · 存失败之后`, await measure(page), view)
      // 量完就收掉：留着的话下面每一屏都跟着变矮，而那些判据量的是别的功能。
      // （「知道了」也是用户真会按的一个按钮。）
      await page.getByRole('button', { name: '知道了' }).click()
      await page.waitForTimeout(200)
      saveFails = false

      // ── 对话页（Task 6）──────────────────────────────────────────────
      // 传完照片就有了**一条真的会话**（Task 4 那条 `POST /api/sessions` 建的），
      // 所以这一屏量的是真数据，不是夹具。
      await page.goto(`${APP}/sessions`, { waitUntil: 'load' })
      await page.waitForSelector('.session-row', { timeout: 15_000 })
      // 缩略图是**一张张取**的：等它们都落地再量（没取到的会在下面那条里报出来）
      await page.waitForFunction(
        () => [...document.querySelectorAll('.session-thumb')].every(i => i.complete),
        null, { timeout: 10_000 }).catch(() => { /* 解不开的下面那条会报出来 */ })
      judgeSessions(`${view.name} · 对话页（传完照片那一条）`,
        await measureSessions(page), view, 'list')

      // ★ 就地确认那一态。⚠️ 必须量：它比常态**更宽**（多一句问话 + 两颗按钮），
      //   而 390px 上那一行本来就已经是最挤的一处。
      await page.locator('.session-row .session-del').first().click()
      await page.waitForSelector('.session-ask', { timeout: 5_000 })
      // ★ 量之前**把指针挪开**（2026-10-01 评审）：刚点的「删除」在常态里是最右边那颗，
      //   而确认态里最右边变成了「取消」—— 不挪的话量到的是**悬停态**，
      //   而悬停态两颗天生不同色，"修复被撤掉"这件事就永远量不出来（探针会绿地骗人）。
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      judgeSessions(`${view.name} · 对话页（正在问"删掉这条？"）`,
        await measureSessions(page), view, 'confirm')
      // 量完收回（「取消」也是用户真会按的按钮）。不收的话下面每一屏都多一样东西，
      // 而那些判据量的是别的功能。
      await page.getByRole('button', { name: '取消' }).click()
      await page.waitForTimeout(200)

      // ★ 再走**长名字**那一行。理由：名字是这一行里最脆的一格 —— flex 孩子的
      //   默认 `min-width: auto` 不肯缩到内容宽度以下，长名字会把整行顶出去，
      //   而**只有长名字时才看得出来**（短名字那些行一切正常，探针全绿）。
      //   这条会话走真接口建、带一个很长的中文名。
      //   ⚠️ **它是不是第一行，判据不许依赖**（2026-10-01 改）：App 自己在换页那一刻
      //   会把还没到点的那趟落盘发出去（I1 的修复，正确行为），那一下可能把另一条
      //   会话的时间戳顶上来、把这条挤到第二行。所以下面**按名字点名量它**
      //   （`measureSessions(page, 名字)`）—— 量谁由名字定，不由"第几行"定。
      const longName = '二〇二六年国庆节在凤凰古城拍的那一张照片.jpg'
      const longShown = longName.replace(/\.[^.]+$/, '')
      const seededSession = await page.evaluate(async (cfg) => {
        const c = document.createElement('canvas')
        c.width = cfg.w
        c.height = cfg.h
        const g = c.getContext('2d')
        // ⚠️ 这两块**故意用中性灰**，不用界面的强调色（2026-10-03 改）。
        //   原来写的是当年那两档品牌粉 `#c3417e` / `#ae376f` —— 换色之后它们
        //   变成了"探针里留着的旧色号"，而且这条会话是**真的建在 dev 库里**的：
        //   对话页第一行会挂着一块粉方块，看着像个界面 bug（实拍撞到过）。
        //   灰的不跟着调色板走，以后换多少次色都不会再出现这种事。
        g.fillStyle = '#8b8b93'; g.fillRect(0, 0, cfg.w, cfg.h)
        g.fillStyle = '#4a4a52'; g.fillRect(0, Math.round(cfg.h / 3), cfg.w, Math.round(cfg.h / 3))
        const r = await fetch('/api/sessions', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.6), name: cfg.name }),
        })
        return r.status
      }, { w: SEED_IMAGE_W, h: SEED_IMAGE_H, name: longName })
      if (seededSession !== 200) {
        fails.push(`${view.name}：造一条长名字的会话没成功（HTTP ${seededSession}）—— ` +
          '下面那条判据就没有能信的数据了')
      }
      await page.goto(`${APP}/sessions`, { waitUntil: 'load' })
      await page.waitForSelector('.session-thumb', { timeout: 15_000 })
      const longOne = await measureSessions(page, longShown)
      judgeSessions(`${view.name} · 对话页（名字很长的那一行）`, longOne, view, 'list')
      if (longOne.name !== longShown) {
        fails.push(`${view.name}：名单里找不到那条长名字的会话（读到的是「${longOne.name}」）——` +
          '这条判据没量到它要量的东西')
      }
      // ⚠️ **只在窄屏上要它截断**：桌面那一行有 1140px 宽，20 个字放得下 ——
      //    那里不截断是**对的**（判"必须截断"会把好版面判红）。
      //    窄屏上不截断则是"名字那格不再收窄"的信号：下一步就是整行被顶出屏幕。
      if (view.width <= 640 && !longOne.nameClipped) {
        fails.push(`${view.name}：那条名字（${longShown.length} 个字）` +
          '在这条窄屏上居然一点都没被截断 —— 要么名字那格不再收窄了' +
          '（长名字会把整行顶出去，而页面横向溢出那条判据只在**已经顶出去**之后才红）')
      }

      // ── 作品页（Task 11）────────────────────────────────────────────
      // 先在**真接口**上放几张：图是页面里现画的一张小 JPEG，不在脚本里塞一串
      // 几百个字符的 base64（那一串没人看得出是什么）。
      //
      // ⚠️ **画成竖的（600x900），不是 64x64 的小方块**（Task 12 改）。理由：
      // 详情页那一段要量的前提是"这一页比一屏长" —— 一张 64x64 的图在手机上
      // 高度才 64px，详情页整页不到 600px、压根没得滚，于是"文档滚了 0px、
      // 左栏 @top 0"这种判据**永远不会红**（等于没写）。竖图在手机上是
      // 350×525，详情页稳稳超过一屏（判据自己还钉着下界，见 judgeDetail）。
      // 作品页那两段不受影响：缩略图是 `aspect-ratio: 1/1; object-fit: cover`。
      //
      // ⚠️⚠️ **原图和缩略图必须是两张、而且缩略图真的小（终审 C1 的那一半）。**
      // 这里原来是 `{ image, thumb: image }` —— **同一张 600x900**，于是 `/thumb`
      // 在检查里回的是全尺寸图，而详情页那条判据（当时只判 `naturalWidth > 0`）
      // 对"详情页把缩略图当大图"**永远失明**。所以 seed 和判据必须**一起**改：
      // 只改判据，它照样看不见；只改 seed，判据照样只问"有像素没有"。
      const seeded = await page.evaluate(async (cfg) => {
        const c = document.createElement('canvas')
        c.width = cfg.w
        c.height = cfg.h
        const g = c.getContext('2d')
        g.fillStyle = '#4c8dff'; g.fillRect(0, 0, c.width, c.height)
        g.fillStyle = '#14161a'; g.fillRect(150, 225, 300, 450)
        const image = c.toDataURL('image/jpeg', 0.6)
        // 缩略图用**真客户端那套算法**缩（`shared/size.ts` 的 fitWithin：等比、长边 ≤ max），
        // 所以 600x900 → 320x480（上限是应用里那个 `GALLERY_THUMB_MAX_SIDE`，
        // 见文件上面 import 那段），和 `makeThumbnail(source, 480)` 的产出同一个尺寸。
        // ⚠️ 这里**必须**和真应用同一个上限，否则下面那条"缩略图不许被拉大"的判据
        //    量的是**这个夹具**、不是应用 —— 夹具永远大、判据永远绿（那就是假绿）。
        const k = Math.min(1, cfg.thumbMax / Math.max(cfg.w, cfg.h))
        const tc = document.createElement('canvas')
        tc.width = Math.round(cfg.w * k)
        tc.height = Math.round(cfg.h * k)
        const tg = tc.getContext('2d')
        tg.imageSmoothingQuality = 'high'
        tg.drawImage(c, 0, 0, tc.width, tc.height)
        const thumb = tc.toDataURL('image/jpeg', 0.7)
        const out = []
        for (let i = 0; i < cfg.n; i++) {
          const r = await fetch('/api/works', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ image, thumb }),
          })
          const body = await r.json().catch(() => null)
          out.push(r.status === 200 && body ? body.id : `HTTP ${r.status}`)
        }
        return out
      }, { n: GALLERY_SEED, w: SEED_IMAGE_W, h: SEED_IMAGE_H, thumbMax: SEED_THUMB_MAX })
      if (seeded.some(x => typeof x !== 'number')) {
        fails.push(`${view.name}：走真接口放作品没成功（${seeded.join('/')}）—— ` +
          '后面那条懒加载的判据就没有能信的数据了')
      }

      await page.goto(`${APP}/works`, { waitUntil: 'load' })
      await page.waitForSelector('.gallery-cell', { timeout: 15_000 })
      // 缩略图是**一张张取**的（§3.5 的"图片柜"）：等它们都落地再判
      await page.waitForFunction(
        () => [...document.querySelectorAll('.gallery-thumb')].every(i => i.complete),
        null, { timeout: 10_000 }).catch(() => { /* 解不开的会在下面那条里报出来 */ })
      const real = await measureGallery(page)
      judgeGallery(`${view.name} · 作品页（真接口放的 ${GALLERY_SEED} 张）`, real, view)
      if (real.cells !== GALLERY_SEED) {
        fails.push(`${view.name}：真接口放了 ${GALLERY_SEED} 张作品，页面上却摆出来 ${real.cells} 张`)
      }
      if (real.thumbsDecoded === 0) {
        fails.push(`${view.name}：一张缩略图都没解开（.gallery-thumb 的 naturalWidth 全是 0）——` +
          '列表上那些图根本没取到')
      }
      if (!real.end) {
        fails.push(`${view.name}：作品全摆完了，却没有那句「没有更多了」`)
      }

      // ── 详情页（Task 12）────────────────────────────────────────────
      // 点第一格进去 —— 和用户做的是同一件事（`onOpen` 那条路）。
      // ⚠️ 必须在装那 500 条的假响应**之前**做完：那批假 id 是不存在的，
      //    点进去只会拿到一个 404 的详情页，量出来的会是错误界面。
      await page.locator('.gallery-cell').first().click()
      await page.waitForSelector('.detail', { timeout: 15_000 })
      await page.waitForFunction(
        () => document.querySelectorAll('.recipe-box').length === 2,
        null, { timeout: 10_000 })
      // 大图落地之后再量：图没加载完的话版面还会动。
      // ⚠️ 这里**只等不判** —— "解开了没有"和"拿的是不是原图"两条判据都在 `judgeDetail` 里
      //   （终审 C1 把判据从"有像素"升成"必须是原图"时就一起收过去了）。
      //   在这儿再判一遍的话，同一个毛病会红两次、而且**判据只有那一条**在讲为什么。
      await page.waitForFunction(
        () => (document.querySelector('.detail-image')?.naturalWidth ?? 0) > 0,
        null, { timeout: 10_000 }).catch(() => { /* 取不到就在下面那条判据里报出来 */ })

      // ★ 用**滚轮**滚（和用户做的是同一件事），滚到底再量。
      // ⚠️ 不能图省事写 `d.scrollTop = d.scrollHeight`：那样量的只是"这个元素
      //    能不能滚"，**文档那条永远会是 0**（谁也没去滚文档）—— 于是"左栏会不会
      //    被划走"这条判据永远不会红，等于没写。滚轮落下来由浏览器决定是详情页滚
      //    还是整个文档滚，两个问题一次量完。（作品页那段同一个道理。）
      const dbox = await page.locator('.detail').boundingBox()
      await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2)
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 4000)
        await page.waitForTimeout(120)
      }
      const detail = await measureDetail(page)
      judgeDetail(`${view.name} · 详情页（一路滚到底之后）`, detail, view)
      // 滚到底时最后那一栏一定看得见，所以"两栏都在屏内"这条在**这一屏**是能验的。
      // 顺带看一眼：名字得在（它是"这张图怎么来的"的回答对象）。
      if (!detail.name) {
        fails.push(`${view.name}：详情页上没有名字（.detail-name 是空的）`)
      }

      // 500 条：**只能造假**（理由见上面那段长注释）。id 故意用不存在的 ——
      // 那些格子里的图会是 404，而这段量的是版面：格子不该因为图取不到就塌掉
      // （.gallery-thumb 的 aspect-ratio 就是干这个的）。
      const fake = Array.from({ length: GALLERY_FAKE }, (_, i) => {
        // ⚠️ 隔两天排：有夏令时的时区里"差一天"可能落回同一个"天"，
        //    那样 60 组里会有多于 60 张，这条判据就会莫名其妙地红
        const t = Date.now() - i * 2 * DAY_MS
        return { id: 100000 + i, alias: null, createdAt: t, updatedAt: t, bytes: 1234, hasThumb: true }
      })
      await page.route('**/api/works', r => (r.request().method() === 'GET'
        ? r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ works: fake }),
          })
        : r.continue()))

      await page.goto(`${APP}/works`, { waitUntil: 'load' })
      await page.waitForSelector('.gallery-cell', { timeout: 15_000 })
      const first = await measureGallery(page)
      judgeGallery(`${view.name} · 作品页（${GALLERY_FAKE} 条，刚打开）`, first, view)
      // ★ §10 那一条：首屏**不能一次全渲染**
      if (first.cells > GALLERY_FIRST) {
        fails.push(`${view.name}：${GALLERY_FAKE} 条作品一次全渲染了（首屏 ${first.cells} 格）——` +
          `§10 点名要防的就是这个（屏幕会卡），一次只该先摆 ${GALLERY_FIRST} 张`)
      }
      // ★ §3.5：「那个圈**必须转**」—— 没有它，用户会以为到底了。
      // ⚠️ 这一条量的是"那个圈**渲染出来了**"（有布局宽度＝存在、没被藏起来）——
      // **没有**量它在不在视野里：滚到底之后它是列表最后一个子元素，那种断言
      // 几乎恒为真，是"看着在守、其实守不住"，不写。
      if (!first.more || !first.more.hasBox) {
        fails.push(`${view.name}：还有没摆完的，页面上却没有那个"正在取…"的圈（没渲染出来）——` +
          '用户会以为到底了，而不是"还在加载"')
      }
      if (first.end) {
        fails.push(`${view.name}：还剩 ${GALLERY_FAKE - first.cells} 条没摆，就已经说「没有更多了」`)
      }

      // ★ 真的用**滚轮**往下滚 —— 和用户做的是同一件事。
      //
      // ⚠️ 不能图省事写成 `g.scrollTop = g.scrollHeight`：那样量的只是"这个元素
      //    能不能滚"，而左边那句 `docScroll` 永远会是 0（谁也没去滚文档）——
      //    于是"左栏会不会被划走"这条判据**永远不会红**，等于没写。
      //    滚轮落下来由浏览器决定是列表滚还是整页滚，两个问题一次量完。
      const box = await page.locator('.gallery').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      let grew = false
      for (let i = 0; i < 5 && !grew; i++) {
        await page.mouse.wheel(0, 20_000)
        try {
          await page.waitForFunction(
            n => document.querySelectorAll('.gallery-cell').length > n,
            first.cells, { timeout: 3_000 })
          grew = true
        } catch { /* 再滚一下；五次都没接上就由下面那条报出来 */ }
      }
      const after = await measureGallery(page)
      judgeGallery(`${view.name} · 作品页（滚到底之后）`, after, view)
      if (!grew) {
        fails.push(`${view.name}：滚到底了却没接上后面的（还是 ${after.cells} 格）——` +
          '那个圈在转，可东西永远取不回来')
      }
    } finally {
      await page.close()
    }
  }

  // ══ 落地页（2026-09-30 从样页合并进来）—— **它现在是门口，所以也得量** ══
  //
  // 为什么单开一块、而且**必须是不带登录态的新 page**：上面那些都走登录态、
  // 都要夹具，而落地页是给**没登录的访客**看的那一页 —— 拿着 cookies 去量，
  // 量到的根本不是访客看到的东西（App 里那条 replace 跳转会把登录着的人
  // 直接送去 `/app`，于是量到的是修图页，而检查照样绿）。
  // 这一块从头到尾**没有夹具、没有登录**，就是"陌生人第一次打开这个网址"。
  //
  // 判四件事，每一件都能说出错了会怎样：
  //   ① 站的是门口、不是白屏也不是 App —— 门口站错了人，后面全白搭；
  //   ② 每张图都**真的解出来了** —— 图挂了页面上就是一块空白，而**浏览器
  //      不会报任何错**（搬迁时改了文件名、少 import 一张，长的就是这个形状）；
  //   ③ 不横向溢出 —— 这一页有几处 `100vw` 的破格（底部照片带），
  //      窄屏上最容易顶出一根横向滚动条；
  //   ④ 标题和那颗按钮**都在首屏里**（不用滚就看得见）—— 门面的第一句和
  //      第一个动作就是它的全部，压在折线以下是白写。
  for (const view of VIEWS) {
    const page = await browser.newPage({
      viewport: { width: view.width, height: view.height },
      deviceScaleFactor: view.deviceScaleFactor, isMobile: view.isMobile, hasTouch: view.hasTouch,
    })
    try {
      await page.goto(URL, { waitUntil: 'load' })
      await page.waitForSelector('.lp', { timeout: 15_000 })
      await page.waitForFunction(
        () => [...document.querySelectorAll('.lp img')].every(i => i.complete),
        null, { timeout: 15_000 }).catch(() => { /* 解不开的下面那条会报出来 */ })
      const m = await page.evaluate(() => {
        const box = el => {
          if (!el) return null
          const b = el.getBoundingClientRect()
          return { top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width) }
        }
        const imgs = [...document.querySelectorAll('.lp img')]
        return {
          h1: box(document.querySelector('.lp h1')),
          cta: box(document.querySelector('.lp-hero .lp-btn')),
          imgCount: imgs.length,
          broken: imgs.filter(i => !i.naturalWidth).length,
          docW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          vh: window.innerHeight,
        }
      })
      console.log(`── ${view.name} · 落地页（没登录的访客）`)
      console.log(`     ${m.imgCount} 张图，解不出来的 ${m.broken} 张；` +
        `大标题 ${m.h1?.w}px 宽 @${m.h1?.top}；按钮 @${m.cta?.top}~${m.cta?.bottom}（视口 ${m.vh} 高）`)
      if (m.broken > 0) {
        fails.push(`${view.name}：落地页有 ${m.broken} 张图解不出来 —— 那几块会是空白，` +
          '而浏览器不会报任何错（图名对不上、少 import 一张，长的就是这个样子）')
      }
      if (m.docW > m.clientW + TOL) {
        fails.push(`${view.name}：落地页横向溢出（文档 ${m.docW} > 视口 ${m.clientW}）—— ` +
          '门口多出来一根横向滚动条')
      }
      if (!m.h1 || m.h1.top < 0 || m.h1.bottom > m.vh) {
        fails.push(`${view.name}：落地页的大标题不在首屏里（@${m.h1?.top}~${m.h1?.bottom}）`)
      }
      if (!m.cta || m.cta.bottom > m.vh) {
        fails.push(`${view.name}：落地页那颗「免费开始」压在折线以下` +
          `（@${m.cta?.bottom} vs 视口 ${m.vh}）—— 门口的第一个动作得不用滚就看得见`)
      }

      // ★ 键盘走一遍：**可聚焦的东西必须看得见。**
      //
      // 为什么加这一条（2026-09-30）：用户问「那这样的问题你做测试的时候怎么没发现」，
      // 我回头把"机器判不了的维度"补了一遍，其中包括**走一次纯键盘** ——
      // 一按就抓到了：右下角那个「回到顶部」在页面顶上时是 `opacity: 0`，
      // 但它**还在 Tab 顺序里**，于是键盘用户进门第一次按 Tab，焦点落在
      // 一个看不见、也点不动（`pointer-events: none`）的按钮上。
      //
      // 这一类四样检查一样都看不见：它不报错、不改版面、点了也不崩 ——
      // 只是"按了没反应"。而它是**能机器判的**（不像文案好不好听），
      // 所以不该靠人肉去发现。
      const 走过 = []
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab')
        const f = await page.evaluate(() => {
          const e = document.activeElement
          if (!e || e === document.body) return null          // 焦点绕出页面了 —— 正常
          const st = getComputedStyle(e)
          const r = e.getBoundingClientRect()
          return {
            what: (e.getAttribute('aria-label') || e.innerText || e.value || '').trim().slice(0, 20),
            see: Number(st.opacity) > 0.05 && st.visibility !== 'hidden' && st.display !== 'none',
            onScreen: r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < window.innerHeight,
          }
        })
        if (!f) break
        走过.push(f)
      }
      console.log(`     键盘走前 ${走过.length} 站：` + 走过.map(f => f.what || '(无名)').join(' → '))
      for (const f of 走过) {
        if (!f.see || !f.onScreen) {
          fails.push(`${view.name}：键盘 Tab 到了一个**看不见**的控件（「${f.what}」）—— ` +
            '用户按下去像"没反应"，得再按一次才知道跳过去了。' +
            '（元凶通常是"只写了 `opacity: 0` 却没写 `visibility: hidden`"的隐藏控件：' +
            '前者只是透明，仍然在 Tab 顺序里。）')
        }
      }
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  for (const f of fails) console.log('❌', f)
  console.log('')
  console.log('窄屏规则在 src/styles.css 末尾那条 @media (max-width: 640px)；')
  console.log('宽窄两档共用的画布容器规则是 .canvas-wrap / .canvas（文件中部）；')
  console.log('红圈的定位/大小在 src/ui/Canvas.tsx（markerSize）和 src/image/mark.ts')
  console.log('（markerRadius，两边共用同一个公式）；作品页的排版在 src/styles.css 末尾那一段')
  console.log('（.gallery 的 overflow-y: auto 就是"列表自己滚、左栏才不会被划走"那一句）；')
  console.log('详情页的排版在 src/styles.css 的 .detail 那一段（同一条 overflow-y: auto）。')
  console.log('存失败横幅的排版在 src/styles.css 的 `.ask, .save-fail` 那一段（`flex-wrap` 就是')
  console.log('窄屏上换不换行那一句）；那个按钮在 src/App.tsx 的 `.save-fail` 那一段里。')
  console.log('上传前那一屏在 src/ui/Uploader.tsx（2026-10-03 起它上面只剩标志、')
  console.log('一句话说清这是什么、那条对话输入框），它的排版在 src/styles.css 的 `.welcome` 那一段。')
  process.exitCode = 1
} else {
  console.log(`✅ ${VIEWS.length} 档 × 3 种状态都过（刚传完照片 / 打开调色面板 / 存失败之后）：` +
    `照片 ≥ ${MIN_LONG}x${MIN_SHORT}、画布完整在视口内、输入框在屏内、不用左右滑、`)
  console.log('   外加：红圈圆心落在点的地方、直径按画布长边算、小图真的解得出像素（全程零付费调用）')
  console.log('   外加存失败（§6.6 ①）：横幅和那个「下载到电脑」都完整在视口里、不用滚动、' +
    '画布还在、两个按钮的字各顶一行（不被 flex 挤扁）')
  console.log(`   外加作品页：${GALLERY_FAKE} 条时首屏只摆 ${GALLERY_FIRST} 张、圈在转、` +
    '滚到底真的接上后面的、整页不滚（左栏钉在原地）')
  console.log('   外加作品页列表上那张缩略图**不是被拉大的**（源像素 ≥ 它被显示出来要的' +
    '设备像素；只判桌面档，理由见 judgeGallery 那段）')
  console.log(`   外加详情页：那张大图真的是原图（自然尺寸的长边 ≥ ${SEED_IMAGE_LONG}，不是 ${SEED_THUMB_MAX}px 的缩略图）、` +
    '两栏配方都在屏内、详情页自己滚而整页不滚（左栏还钉在原地）')
  console.log(`   外加落地页（${VIEWS.length} 档，**不带登录态的访客视角**）：13 张图全解得出、不横向溢出、` +
    '大标题和「免费开始」都在首屏里')
  console.log(`   外加上传前那一屏（${VIEWS.length} 档）：整列不被切（这屏现在矮，` +
    '正因如此它是"再往里加东西会不会被切"的唯一哨兵）')
}
