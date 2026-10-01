/**
 * 把**用户真正看得到的字**全部打出来，好让人通读一遍。
 *
 * 为什么需要它 —— 2026-09-30 那天：
 *   我做完一整轮界面测试（511 条测试 + 两个版面检查 + 37 项全链路回归），
 *   全绿；用户指着顶栏那三个词说「**换个专业的说法，现在太口语化了**」。
 *
 *   不是疏忽，是**缺一维**：那些检查量的全是「能不能用」（图加载了没有、
 *   溢出不溢出、按钮在不在首屏），而文案是「好不好听」——机器没有判据，
 *   所以它从来没被测过。而这一维的漏洞，**从来不是"没能力判"，是"没人读"**。
 *
 * 所以这条脚本不做判断，只做一件事：**把稿子端出来，逼人读**。
 *
 * ⚠️ 两个刻意的选择：
 *   ① **从运行中的页面捞，不 grep 源码。** 源码里大半字符串是给我自己看的
 *      （注释、日志、变量名），而且有些话是拼出来的（`这张照片 ${w}×${h} 太大了`）。
 *   ② **边界状态也要走一遍。** 出错、空、等待那几屏的文案，正常路径上根本碰不到
 *      —— 而它们恰恰是最少被人读过的字。这个脚本会故意把每一路弄坏一次。
 *
 * 用法（服务器开着就行）：
 *   npm run dev
 *   npm run check:copy
 *
 * ⚠️ 它**一分钱不花**：/api/suggest、/api/route、/api/edit 三条都掐掉了
 *   （前两条真调模型，第三条一次约 12,900 tokens）。要看的是字，不是效果，
 *   所以掐掉不影响这份稿子的完整性。
 *   它会**现注册一个临时账号**（跟 check-mobile-layout 同款做法）——
 *   修图界面的文案在登录墙后面，不注册就看不到。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const URL = process.env.DEV_BASE ?? 'http://localhost:5173'
const APP = `${URL}/app`
const PHOTO = join(ROOT, 'test-photos', 'e2e_first_use.jpg')

const out = []

/** 把这一屏上所有看得见的文字按块抓下来（保留层次，去掉隐藏的）。 */
async function grab(page, tag) {
  const items = await page.evaluate(() => {
    const acc = []
    const walk = (el) => {
      for (const n of el.children) {
        const style = getComputedStyle(n)
        const hidden = style.display === 'none' || style.visibility === 'hidden'
        if (!hidden) {
          // 只取这个节点**自己**的文字（不含子节点），这样层次不会糊成一行
          const own = [...n.childNodes]
            .filter(c => c.nodeType === 3)
            .map(c => c.textContent).join('').trim()
          if (own) acc.push(own)
        }
        if (n.children.length) walk(n)
      }
    }
    walk(document.body)
    return acc
  })
  const seen = new Set()
  const kept = []
  for (const t of items) {
    const s = t.replace(/\s+/g, ' ').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    kept.push(s)
  }
  if (kept.length) out.push({ tag, kept })
}

/** 这一路真的花钱（前两条调模型，第三条一次约 12,900 tokens）。全部掐掉。 */
async function mutePaidRoutes(page) {
  await page.route('**/api/suggest', r => r.abort())
  await page.route('**/api/route', r => r.abort())
  await page.route('**/api/edit', r => r.abort())
}

/** 假的路由决策：route 那条**用假响应 fulfill**，一次模型都不调（花钱的路）。 */
const FAKE_DECISION = JSON.stringify({
  decision: {
    route: 'generate', paramDeltas: {}, reply: '好，这就去掉。',
    editPrompt: 'Remove the person in the background.',
    needsDisambiguation: false, degraded: false,
  },
})

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  // ── 门面（访客，没登录）────────────────────────────────────────────
  {
    const page = await ctx.newPage()
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('.lp', { timeout: 15_000 })
    await page.waitForTimeout(800)
    await grab(page, '落地页 · 访客')
    await page.close()
  }

  // ── 登录 / 注册 / 报错 ────────────────────────────────────────────
  {
    const page = await ctx.newPage()
    await page.goto(APP, { waitUntil: 'networkidle' })
    await page.waitForSelector('.login-box', { timeout: 15_000 })
    await grab(page, '登录页')
    await page.click('.login-switch'); await page.waitForTimeout(300)
    await grab(page, '注册页')
    await page.click('.login-switch'); await page.waitForTimeout(300)
    await page.fill('input[name=username]', '一个不存在的名字zz')
    await page.fill('input[name=password]', 'WrongPass123')
    await page.click('.login-submit'); await page.waitForTimeout(2000)
    await grab(page, '登录页 · 报错')
    await page.close()
  }

  // ── 现注册一个临时账号（修图界面的文案全在登录墙后面）────────────
  {
    const page = await ctx.newPage()
    await page.goto(APP, { waitUntil: 'networkidle' })
    await page.waitForSelector('.login-box', { timeout: 15_000 })
    await page.click('.login-switch'); await page.waitForTimeout(300)
    const name = `文案巡读${Date.now() % 100000}`
    await page.fill('input[name=username]', name)
    await page.fill('input[name=password]', 'CopyAudit123')
    await page.fill('input[name=email]', `${Date.now()}@copy.audit`)
    await page.click('.login-submit')
    await page.waitForSelector('.nav', { timeout: 20_000 })
    // ★ 空态那两句（「还没改过照片。」+「去改一张」）只有**一条会话都没有**的账号
    //   看得到 —— 而那是新用户点进「对话」的**第一眼**。趁照片还没传，先抓下来：
    //   传完之后就再也回不到这一屏了（哪怕换一页重新打开也至少有一条）。
    await page.goto(`${APP}/sessions`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.sessions-empty', { timeout: 15_000 })
    await grab(page, '对话页 · 一条会话都没有')
    await page.close()
  }

  // ── App：上传前 / 坏图 / 有图 / 调色 / 保存 ───────────────────────
  {
    const page = await ctx.newPage()
    await mutePaidRoutes(page)
    await page.goto(APP, { waitUntil: 'networkidle' })
    await page.waitForSelector('.nav', { timeout: 20_000 })
    await grab(page, 'App · 上传前')

    // 故意传一个不是图的东西 —— 那一条通报平时碰不到。
    // ⚠️ **别改成"读 scratch/ 里的一个坏文件"**（2026-10-01 修）：那个文件没人会去建，
    //    `setInputFiles` 抛错又被 `.catch(() => {})` 吞掉，于是这一屏**什么都没发生**，
    //    抓下来的是上一屏的复制品 —— 而边界状态的文案正是最少被人读过的字，
    //    静默跳过等于这一维根本没量（"绿了，其实没测到"，这个仓库最贵的一类坑）。
    //    用内存里的 buffer：脚本自给自足，也不可能再静默变成空操作。
    await page.setInputFiles('input[type=file]', {
      name: '这不是照片.txt', mimeType: 'text/plain', buffer: Buffer.from('这不是一张照片'),
    })
    await page.waitForTimeout(1500)
    await grab(page, 'App · 传了一张打不开的文件之后')

    // 真照片：先抓"还在看照片"那一瞬间，再抓调色面板
    await page.setInputFiles('input[type=file]', PHOTO)
    await page.waitForTimeout(1200)
    await grab(page, 'App · 刚传完（还在看照片）')

    // ── ★ 2026-09-30 加：「生成中」那一格 ────────────────────────────────
    // 为什么单独走一趟：**「停止」这两个字只在忙的时候存在**（平时那一格是
    // 「发送」），上面每一屏都看不到它 —— 而这一维的漏洞从来不是"没能力判"，
    // 是"没人读"。生成中、按完停止之后说的话，都是最少被人读过的字。
    //
    // ⚠️ 仍然**一分钱不花**：route 用假决策 fulfill；edit 干脆挂住不回
    //   （真跑一次约 12,900 tokens）。
    await page.unroute('**/api/route')
    await page.route('**/api/route', r => r.fulfill({
      status: 200, contentType: 'application/json', body: FAKE_DECISION,
    }))
    await page.unroute('**/api/edit')
    await page.route('**/api/edit', () => { /* 挂住不回 = 正在改…大约 10 秒 */ })
    await page.fill('input[name="text"]', '把后面那个人去掉')
    await page.press('input[name="text"]', 'Enter')
    await page.waitForSelector('.chat-input button.stop', { timeout: 15_000 })
    await page.waitForTimeout(300)
    await grab(page, 'App · 生成中（那一格是「停止」）')
    await page.click('.chat-input button.stop')
    await page.waitForTimeout(800)
    await grab(page, 'App · 按了停止之后')
    // 把两条路由还原成"掐掉"，后面的流程照旧（不然挂着的 edit 会让应用永远忙）
    await page.unroute('**/api/edit')
    await page.route('**/api/edit', r => r.abort())

    await page.waitForTimeout(2000)
    await page.click('.actions button:has-text("调色")')
    await page.waitForTimeout(600)
    await grab(page, 'App · 调色面板')

    // 存一张，好让作品页/详情页有东西可看
    await page.click('.actions button:has-text("保存")')
    await page.waitForTimeout(4000)

    // ── 对话页（Task 6）────────────────────────────────────────────────
    // 上传那张照片时已经建了一条会话（Task 4），所以这一屏有真东西。
    await page.click('.nav-item:has-text("对话")')
    await page.waitForSelector('.session-row', { timeout: 15_000 })
    await page.waitForTimeout(800)
    await grab(page, '对话页')

    // ★ 就地确认那三句（「删掉这条？」「删掉」「取消」）**只在按了「删除」之后存在**，
    //   而这一版明确说好**不弹系统框** —— 那三句就是这个产品里"要删东西"时
    //   用户看到的全部字，也恰恰是最少被人读过的那几句。
    await page.click('.session-row .session-del')
    await page.waitForSelector('.session-ask', { timeout: 5_000 })
    await page.waitForTimeout(300)
    await grab(page, '对话页 · 点了「删除」（就地确认）')
    await page.click('.session-row button:has-text("取消")')
    await page.waitForTimeout(300)

    await page.click('.nav-item:has-text("作品")')
    await page.waitForSelector('.gallery-cell', { timeout: 15_000 })
    await page.waitForTimeout(1200)
    await grab(page, '作品页')

    await page.click('.gallery-cell')
    await page.waitForSelector('.detail-image', { timeout: 15_000 })
    await page.waitForTimeout(800)
    await grab(page, '详情页')
    await page.click('.detail-rename'); await page.waitForTimeout(300)
    await grab(page, '详情页 · 改名（输入框态）')
    await page.click('.detail-delete'); await page.waitForTimeout(300)
    await grab(page, '详情页 · 点了删除（确认条）')
    await page.close()
  }

  await browser.close()

  const width = Math.max(...out.flatMap(g => g.kept.map(t => [...t].length)))
  console.log(`\n全站用户可见文案（${out.reduce((n, g) => n + g.kept.length, 0)} 条）`)
  console.log('═'.repeat(Math.min(width + 4, 78)))
  for (const { tag, kept } of out) {
    console.log(`\n── ${tag} ${'─'.repeat(Math.max(0, 60 - tag.length))}`)
    for (const t of kept) console.log('   ' + t)
  }
  console.log('\n通读完之后，核一遍 docs/文案规范.md 里那三条：')
  console.log('  · 这句话在什么情况下是假的？（产品真的做得到吗）')
  console.log('  · 它和旁边那句是不是同一个调子？')
  console.log('  · 往前翻，同一个东西前面叫什么？')
}

main().catch(e => { console.error(e); process.exitCode = 1 })
