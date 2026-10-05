/**
 * 滤镜（LUT）的真机验收 —— **真 Chrome、真 GPU、零模型调用**。
 *
 * 它验的是**渲染链上的契约**，而期望值全部来自 **CPU 对照**
 * （`src/core/lut.ts` 的 `applyLut` + `src/core/tone.ts` 的 `applyTone`）。
 * 为什么非要这样：GPU 那半进不了 vitest（要真 WebGL2），所以这几类错误
 * **除了这里没有第二个地方抓得到** ——
 *   · shader 和 CPU 双胞胎走岔了（其中一个改了、另一个没跟）；
 *   · LUT 段被挪到参数之前（改一个位置的顺序，所有老作品的颜色都会变）；
 *   · 强度 0 不是恒等（画面上"摘掉滤镜"之后还留着一层颜色）；
 *   · 半格校正 / domain 换算漏了（n=2 的表会把输入 0.25 变成纯黑）。
 *
 * ⚠️ **零模型调用**：`/api/suggest`、`/api/edit` 两条花钱的路全拦掉，
 *    `/api/route` 用**假决策**兑上（形状照 `shared/protocol.ts` 的 `RouteResponse`）。
 *    整条探针一个 token 都不花 —— 它每次运行都要跑，绝不能是花钱的。
 *
 * ⚠️ 它**注册一个临时账号**（和 `scripts/check-mobile-layout.mjs` 同一个套路：
 *    随机名字、dev 库、`data/` 已 gitignore）—— 注册限流 **20 个/小时/IP**，
 *    **别连跑**。跑它之前确认 dev 服务器开着（`npm run dev`），它自己**不起服务**。
 *
 * 断言 12 条（编号 = 2026-10-05 滤镜 Task 13 清单里的编号）：
 *   1a 强度 0 与「不用」逐字节相同；1b 强度 100 必须不同
 *   2  方向：红蓝对调的表在已知像素上确实对调，且与 CPU 对得上
 *   3  强度 50 落在两者之间，且与 CPU 对得上
 *   4  顺序：LUT 在参数**之后**（== applyLut(cube, applyTone(px, …), 100)）
 *   5  domain≠[0,1] 的表：同一个像素与 CPU 对得上（同时钉住半格校正和 domain 换算）
 *   6  选了滤镜**不碰别的**，画面自己变（cube 是**异步**到手的）
 *   7  F5 之后滤镜还在（会话恢复把最后一步的 lut 带回来，画布画的是带滤镜的结果）
 *   8  说话那条路：「用黄昏那个滤镜」→ 格子上亮起来、画面变
 *   9  「不要滤镜了」→ 回到「不用」
 *   10 只调滤镜的那句话：`/api/edit` **一次都没被调用**（钱闸）
 *   11 同一次决策「既生成又换滤镜」→ 点那一步的「回到这一步」，滤镜跟着回来
 *   （12 是截图，见下面 `shot()` 的调用点，落在 `.superpowers/scratch/lut-shots/`）
 */
import { chromium, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLut } from '../src/core/lut.ts'
import { applyTone } from '../src/core/tone.ts'
import { toUnit, ZERO, type Adjustments } from '../shared/adjustments.ts'
import { parseCube, type Cube } from '../shared/lut.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASE = process.env.DEV_BASE ?? 'http://localhost:5173'
/** ★ App 住在 `/app` 底下（`/` 让给落地页）—— 和 check-mobile-layout 同一个坑：
 *  漏改一处的表现是"等一个永远不出现的元素等到超时"，报错里看不出是走错门了。 */
const APP = `${BASE}/app`
const SHOTS = join(ROOT, '.superpowers', 'scratch', 'lut-shots')

/**
 * 容差 **3/255**。GPU 那半是 8bit 纹理 + 单精度插值，CPU 那半是 float64，
 * 对齐到小数点后两位时会有 1~2 个 255 的差；而这条探针要抓的东西
 * （顺序颠倒、半格、domain、强度）都是**几十个 255**的差 —— 中间隔着一条大峡谷，
 * 容差落在峡谷里就是安全的（下面的 CPU 预检把这条峡谷印出来）。
 */
const TOL = 3

/** 上传的那张**纯色**测试图。纯色是有意的：clarity 那一支在纯色上是 0
 *  （没有任何邻域差），于是 CPU 和 GPU 之间只剩舍入差，没有"模糊半径"这种
 *  两边对不齐的东西掺进来。 */
const P255: readonly [number, number, number] = [64, 128, 192]
/** 假"生成"出来的那张图（断言 11 用）：换一个明显不同的颜色，
 *  这样"生成之后画的确实是新底图"和"滤镜跟着回来"两件事各自看得见。 */
const FAKE255: readonly [number, number, number] = [210, 120, 60]

// ══ 四个人造 cube ══════════════════════════════════════════════════════
//
// 全部由**同一个函数**从"一个数学函数"生成文本，再 `parseCube` 解出 CPU 那一份 ——
// 于是上传上去的那份文件和算期望值的那份数据**是同一串字节**，不会漂。
//
// ⚠️ 每一个表的 domain / 形状都不是随手挑的，理由写在各自那一行上面。
/** 生成 `.cube` 文本。行序必须是**红变最快**（和 texImage3D/CPU 的约定一致）。 */
function cubeFile(
  size: number,
  fn: (r: number, g: number, b: number) => [number, number, number],
  opts: { title: string; domainMax?: [number, number, number] },
): string {
  const rows: string[] = []
  for (let k = 0; k < size; k++) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const v = fn(i / (size - 1), j / (size - 1), k / (size - 1))
        // 量化到 8bit 再写文本：`parseCube` 里也是 `Math.round(v*255)`，
        // 这样"文件里写的"和"CPU 手里那 8bit"逐位一致，不留第二种舍入。
        rows.push(v.map((x) => (Math.round(x * 255) / 255).toFixed(6)).join(' '))
      }
    }
  }
  return [`TITLE "${opts.title}"`, `LUT_3D_SIZE ${size}`]
    .concat(opts.domainMax ? [`DOMAIN_MAX ${opts.domainMax.join(' ')}`] : [])
    .concat(rows).join('\n') + '\n'
}

/** 红蓝对调（置换表）。断言 1/2/3 用它 —— 方向这件事只有置换表说得清。 */
const CUBE_SWAP = cubeFile(2, (r, g, b) => [b, g, r], { title: '红蓝对调' })
/**
 * domain 表。断言 5 用它，domain 选 **(1, 0.5, 0.5)** —— 这是量出来的：
 *   · 测试图是 rgb(64,128,192) → b 通道 0.753。DOMAIN_MAX 取 0.5 的话
 *     **三个通道全落在钳制区**，而半格校正的偏差在 t=1 处恰好是 0（两头重合、
 *     中间最大）—— 那张表**测不出半格校正**（我按计划的例子算过：只差 0.002）。
 *   · r 通道留 domain=1 时 t=0.251 ≈ 0.25，**正是半格偏差最大的地方**（差 0.249）；
 *     g/b 通道被 domain 0.5 钳到表尾，**忘掉 domain 换算**的差就有 0.25~0.5。
 *   所以一张表同时钉住两件事（下面的 CPU 预检把这三个数印出来）。
 */
const CUBE_DOMAIN = cubeFile(
  2,
  (r, g, b) => [0.1 + 0.8 * r, 0.05 + 0.9 * g, 0.15 + 0.7 * b],
  { title: '半格表', domainMax: [1, 0.5, 0.5] },
)
/**
 * 强非线性表（gamma 0.2，n=4）。断言 4 用它 —— **置换表在这条上测不出东西**：
 * "只动亮度"的色调链在 sRGB 空间里近似是一次乘法，而乘法与置换**可交换**，
 * 于是把 LUT 挪到参数之前，画面上一个像素都不差（我实测：差 0/255）。
 * 换成真非线性（CPU 预检里量到差 23/255）这条才咬得住。`src/core/lut.test.ts`
 * 里 Task 2 那条同样栽过、同样换成 gamma —— 两边说的是同一件事。
 */
const CUBE_GAMMA = cubeFile(4, (r, g, b) => [r ** 0.2, g ** 0.2, b ** 0.2], { title: '铁曲线' })
/** 温和的暖色表。说话那三条（8/9/11）和 F5 用它 —— 这几条只关心
 *  "选中了哪一个 / 画面变没变 / 回来没有"，不关心数值方向。 */
const CUBE_DUSK = cubeFile(
  2,
  (r, g, b) => [0.15 + 0.7 * r, 0.1 + 0.8 * g, 0.05 + 0.6 * b],
  { title: '黄昏' },
)

const CUBES: readonly { name: string; text: string; cube: Cube }[] = [
  { name: '红蓝对调', text: CUBE_SWAP, cube: parseCube(CUBE_SWAP) },
  { name: '半格表', text: CUBE_DOMAIN, cube: parseCube(CUBE_DOMAIN) },
  { name: '铁曲线', text: CUBE_GAMMA, cube: parseCube(CUBE_GAMMA) },
  { name: '黄昏', text: CUBE_DUSK, cube: parseCube(CUBE_DUSK) },
]
const cubeOf = (name: string): Cube => {
  const hit = CUBES.find((c) => c.name === name)
  if (!hit) throw new Error(`没有这个测试 cube：${name}`)
  return hit.cube
}

/** CPU 对照：一个 0–255 的像素经过（可选的）参数 + 查表 + 强度之后的 0–255。 */
function expect255(
  cube: Cube, px255: readonly [number, number, number], amount: number, adj: Adjustments = ZERO,
): [number, number, number] {
  const out = applyLut(
    cube,
    applyTone([px255[0] / 255, px255[1] / 255, px255[2] / 255], toUnit(adj)),
    amount,
  )
  return [Math.round(out[0] * 255), Math.round(out[1] * 255), Math.round(out[2] * 255)]
}

const dist = (
  a: readonly [number, number, number], b: readonly [number, number, number],
): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

// ── 结果账本 ────────────────────────────────────────────────────────────
type Row = { id: string; what: string; got: string; ok: boolean }
const rows: Row[] = []
/** 记一条断言。`ok` 之外什么都不猜 —— 实测那栏原样留住，红了要能自己看清楚。 */
function check(id: string, what: string, ok: boolean, got: string): void {
  rows.push({ id, what, got, ok })
  console.log(`   ${ok ? '✅' : '❌'} ${id} ${what} —— ${got}`)
}

// ── 页面小工具 ──────────────────────────────────────────────────────────
/** 读主画布那一个像素（画布是纯色，缩到 1×1 就是它）。没有画布时回 null ——
 *  F5 之后有一段时间 App 还在"正在打开…"（那棵树上没有画布），那不是失败。 */
async function pixelOrNull(page: Page): Promise<[number, number, number] | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.canvas')
    if (!(c instanceof HTMLCanvasElement)) return null
    const t = document.createElement('canvas')
    t.width = 1
    t.height = 1
    const g = t.getContext('2d')
    if (!g) throw new Error('拿不到 2D 上下文')
    g.drawImage(c, 0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]] as [number, number, number]
  })
}

/** 一样，但"没有画布"算异常 —— 只在"画布肯定在"的地方用（直接读一次的那种）。 */
async function pixel(page: Page): Promise<[number, number, number]> {
  const px = await pixelOrNull(page)
  if (!px) throw new Error('找不到主画布（.canvas）')
  return px
}

/**
 * 一直读到 `pred` 成立（画面自己画完），超时返回 null。
 *
 * ⚠️ **poll 而不是 sleep 一次**：cube 是异步到手的（一次网络 + 解析），
 * 换滤镜之后多久画上去没有保证。断言 6 的"自己变"就靠它 —— 轮询期间
 * **不碰页面任何别的东西**，变了就是"没做别的也变了"。
 */
async function waitPixel(
  page: Page, pred: (p: readonly [number, number, number]) => boolean, timeoutMs = 10_000,
): Promise<{ px: [number, number, number]; ms: number } | null> {
  const t0 = Date.now()
  for (;;) {
    const px = await pixelOrNull(page)
    if (px && pred(px)) return { px, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return null
    await page.waitForTimeout(120)
  }
}

/**
 * 把某条滑块拉到某个值。
 *
 * ⚠️ 走 **value 的原生 setter + `input` 事件**：滑块是 Base UI 的受控
 * `<input type="range">`（藏在拇指里），直接 `el.value = 0` 会被 React 的值追踪器
 * 当成"没变"而**不触发 onChange**，表现为"拖了没反应"。走原生 setter 绕过
 * 追踪器，React 就把它当一次真的输入。
 * ⚠️ 找的是 `.slider-label` 上的字（和面板显示名同一个来源）—— 面板上有十五条
 * 滑块，其中「强度」和分离色调那条**重名**，所以按名字找时必须限定在容器里。
 */
async function setSliderIn(page: Page, scope: string, label: string, value: number): Promise<string> {
  return page.evaluate(({ scope, label, value }) => {
    const lab = [...document.querySelectorAll(`${scope} label.slider`)]
      .find((l) => l.querySelector('.slider-label')?.textContent?.trim() === label)
    const el = lab?.querySelector('input[type=range]')
    if (!(el instanceof HTMLInputElement)) return `找不到「${label}」那条滑块`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) return '拿不到 value 的原生 setter'
    setter.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return `读完是 ${el.value}`
  }, { scope, label, value })
}

/** 调色面板里的参数滑块（亮度、对比度…）。 */
const setSlider = (page: Page, label: string, value: number) => setSliderIn(page, '.panel', label, value)
/** 滤镜格子里的「强度」——`.lut-picker` 里唯一那条 range，两个宿主共用。 */
const setLutAmount = (page: Page, value: number) => setSliderIn(page, '.lut-picker', '强度', value)

const tile = (page: Page, name: string) => page.locator('.lut-tile', { hasText: name }).first()

/** 现在格子上亮着哪一个（`.lut-tile.on` 的字）。量不到就是 '（没有）'。 */
const litTile = (page: Page) =>
  page.evaluate(() =>
    document.querySelector('.lut-tile.on .lut-tile-name')?.textContent?.trim() ?? '（没有）')

/** 截图（清单第 12 条：产物落在 `.superpowers/scratch/lut-shots/`）。 */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`   📷 ${name}.png`)
}

/** 假决策（`shared/protocol.ts` 的 RouteResponse）。**每次运行都重新造**，
 *  不改真模型、也不花一分钱。 */
type FakeDecision = {
  route: 'params' | 'generate' | 'both'
  paramDeltas: Record<string, number>
  reply: string
  editPrompt: string
  needsDisambiguation: boolean
  degraded: boolean
  lut: { name: string; amount: number } | null
}
const noLut = (reply = '好。'): FakeDecision => ({
  route: 'params', paramDeltas: {}, reply, editPrompt: '',
  needsDisambiguation: false, degraded: false, lut: null,
})

/** 注册一个临时账号（已有登录态就什么都不做）。 */
async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto(APP, { waitUntil: 'load' })
  await page.waitForSelector('.login-box, input[type="file"]', { timeout: 15_000 })
  if (!(await page.locator('.login-box').count())) return
  const who = `滤镜检查${Date.now().toString(36)}`
  const status = await page.evaluate(async (who) => {
    const r = await fetch('/api/signup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, email: `${who}@example.com`, password: 'lut-check-only' }),
    })
    return r.status
  }, who)
  if (status !== 200) throw new Error(`现注册临时账号「${who}」返回了 HTTP ${status}`)
  console.log(`   登录墙：现注册了临时账号「${who}」（dev 库，已 gitignore）`)
  await page.reload({ waitUntil: 'load' })
}

const nav = (page: Page, name: string) => page.locator('.nav-item', { hasText: name }).first()

// ══ CPU 预检：这些断言**能不能红**，先在没有 GPU 的地方证明一遍 ══════════
//
// 这不是在重复验 CPU 实现（那是 Task 2 的活）；它守的是**探针自己**：
// 哪天有人换掉某个 cube、或者改了测试图的颜色，让某条断言对"坏掉的 shader"
// 变得不敏感，这里当场说出来 —— 否则那条断言会**安安静静地永远绿**。
function preflight(): void {
  console.log('── CPU 预检：拿"坏掉的实现"当假想敌，量一遍分辨力（单位 /255）')
  const exp = (cube: Cube, amount: number, adj: Adjustments = ZERO) => expect255(cube, P255, amount, adj)

  // ① 顺序：正确（LUT 在参数之后）vs 颠倒
  const adj40: Adjustments = { ...ZERO, exposure: 40 }
  const right = exp(cubeOf('铁曲线'), 100, adj40)
  const wrong = applyTone(
    applyLut(cubeOf('铁曲线'), P255.map((v) => v / 255) as [number, number, number], 100),
    toUnit(adj40),
  ).map((v) => Math.round(v * 255)) as [number, number, number]
  const dOrder = dist(right, wrong)
  console.log(`   顺序（铁曲线）：对 ${right.join(',')} / 错 ${wrong.join(',')} → 差 ${dOrder}`)
  check('预检·顺序', '顺序断言的 cube 分得开两种顺序（差要 > 容差）', dOrder > TOL, `${dOrder} > ${TOL}`)

  // ② domain / 半格：正确 vs 两种坏法（纯 CPU 模拟，直接照着 shader 那两行的错法写）
  const cube = cubeOf('半格表')
  const n = cube.size
  const at = (i: number, j: number, k: number, c: number) => cube.rgba[((k * n + j) * n + i) * 4 + c]! / 255
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  /** 逐通道三线性采样，`idx` 决定"输入 → 表下标"这一步怎么算。 */
  const sample = (idx: (v: number, ch: number) => number): [number, number, number] => {
    const q = P255.map((v) => v / 255)
    const x = idx(q[0]!, 0), y = idx(q[1]!, 1), z = idx(q[2]!, 2)
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
    const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1)
    const out: [number, number, number] = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      out[c] = lerp(
        lerp(lerp(at(x0, y0, z0, c), at(x1, y0, z0, c), x - x0), lerp(at(x0, y1, z0, c), at(x1, y1, z0, c), x - x0), y - y0),
        lerp(lerp(at(x0, y0, z1, c), at(x1, y0, z1, c), x - x0), lerp(at(x0, y1, z1, c), at(x1, y1, z1, c), x - x0), y - y0),
        z - z0)
    }
    return out
  }
  const to255 = (v: readonly [number, number, number]) => v.map((x) => Math.round(x * 255)) as [number, number, number]
  const tOf = (v: number, ch: number) =>
    clamp01((v - cube.domainMin[ch]!) / Math.max(cube.domainMax[ch]! - cube.domainMin[ch]!, 1e-6))
  const good = to255(sample((v, ch) => tOf(v, ch) * (n - 1)))
  // 坏法①：忘了半格校正 —— 归一化值直接当纹理坐标，表下标 = u*n−0.5
  const noHalf = to255(sample((v, ch) => clamp01(tOf(v, ch) * n - 0.5)))
  // 坏法②：忘了 domain 换算（当 [0,1]，其余都对）
  const noDom = to255(sample((v) => clamp01(v) * (n - 1)))
  const dHalf = dist(good, noHalf), dDom = dist(good, noDom)
  console.log(`   domain（半格表）：对 ${good.join(',')} / 无半格校正 ${noHalf.join(',')}（差 ${dHalf}）` +
    ` / 忘 domain ${noDom.join(',')}（差 ${dDom}）`)
  check('预检·半格', '半格表分得开"漏了半格校正"', dHalf > TOL, `${dHalf} > ${TOL}`)
  check('预检·domain', '半格表分得开"漏了 domain 换算"', dDom > TOL, `${dDom} > ${TOL}`)
}

// ══ 从这儿开始要真机 ════════════════════════════════════════════════════
async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  preflight()

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    // ── 零模型调用：三条 AI 路全拦 ─────────────────────────────────────
    // 形状照 `shared/protocol.ts`；`/api/route` 用**可换的假决策**兑上，
    // `/api/edit` 平时 abort、断言 11 那一段换成"回一张假图"。
    let decision: FakeDecision = noLut('（探针：没料到会走到这儿）')
    let editMode: 'abort' | 'fake' = 'abort'
    let fakeImage: string | null = null
    const editCalls: string[] = []
    await page.route('**/api/suggest', (r) => r.abort())
    await page.route('**/api/route', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ decision }),
    }))
    await page.route('**/api/edit', (r) => {
      if (editMode === 'fake' && fakeImage) {
        const body = (r.request().postDataJSON() ?? {}) as { width?: number; height?: number }
        return r.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            imageDataUrl: fakeImage, width: body.width ?? 64, height: body.height ?? 64,
          }),
        })
      }
      return r.abort()
    })
    page.on('request', (r) => { if (r.url().includes('/api/edit')) editCalls.push(r.url()) })

    // ── 0. 登录 + 一张纯色测试图 ───────────────────────────────────────
    console.log('\n── 0. 登录、上传纯色测试图')
    await ensureLoggedIn(page)
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15_000 })

    // 设置页截图要在**导入之前**拍（空态），所以顺序是：先量空态 → 导 4 个 → 再量列表。
    console.log('── 1. 设置页 /app/luts（清单四态 / 导入）')
    await page.locator('.nav-me').click()
    await page.waitForSelector('.account', { timeout: 10_000 })
    await page.locator('button.account-row', { hasText: '滤镜' }).click()
    await page.waitForSelector('.luts', { timeout: 10_000 })
    await page.waitForSelector('.luts-empty', { timeout: 10_000 })
    await shot(page, '1-luts-empty')

    for (let i = 0; i < CUBES.length; i++) {
      const c = CUBES[i]!
      await page.setInputFiles('input.luts-file', {
        name: `${c.name}.cube`, mimeType: 'text/plain', buffer: Buffer.from(c.text, 'utf8'),
      })
      await page.waitForFunction((n) => document.querySelectorAll('.luts-item').length === n, i + 1,
        { timeout: 10_000 })
    }
    await shot(page, '2-luts-list')
    // 删除确认块：那句"还有 N 条老会话在用"的 N 来自真接口（`lutUsage`）。
    await page.locator('.luts-item', { hasText: '黄昏' }).locator('button', { hasText: '删除' }).click()
    await page.waitForSelector('.luts-ask', { timeout: 10_000 })
    await shot(page, '3-luts-confirm')
    const askText = await page.locator('.luts-ask p').innerText()
    console.log(`   删除确认块说：「${askText.trim()}」`)
    await page.locator('.luts-ask button', { hasText: '先不删' }).click()
    await page.waitForTimeout(200)

    // ── 上传那张纯色图（页面里现画，setInputFiles 传 buffer）───────────
    await nav(page, '修图').click()
    await page.waitForTimeout(300)
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const g = c.getContext('2d')
      if (!g) throw new Error('拿不到 2D 上下文')
      g.fillStyle = 'rgb(64, 128, 192)'
      g.fillRect(0, 0, 64, 64)
      return c.toDataURL('image/png')
    })
    // 假"生成"那张图：同一个尺寸（64×64），换个颜色。断言 11 要用。
    fakeImage = await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const g = c.getContext('2d')
      if (!g) throw new Error('拿不到 2D 上下文')
      g.fillStyle = 'rgb(210, 120, 60)'
      g.fillRect(0, 0, 64, 64)
      return c.toDataURL('image/png')
    })
    await page.setInputFiles('input[type="file"]', {
      name: '纯色.png', mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'),
    })
    await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
    await page.waitForTimeout(1000)

    // ── 2. 微调区：数值/渲染那五条 + "画面自己变" ──────────────────────
    console.log('\n── 2. 微调区（/app/adjust）：数值与渲染')
    await nav(page, '调色').click()
    await page.waitForSelector('.panel', { timeout: 10_000 })
    await page.locator('.panel-group-head', { hasText: '滤镜' }).click()
    await page.waitForSelector('.lut-picker .lut-tile', { timeout: 10_000 })

    const P_none = await pixel(page)
    // 基线：不装滤镜时，画布上那一个像素**就是上传那张图上的像素**（CPU 期望
    // 在强度 0 时逐字节等于入参）—— 这一条保证的是"读回链路本身没歪"，
    // 下面每一条都踩着它。
    const expNone = expect255(cubeOf('红蓝对调'), P255, 0)
    check('基线', '不装滤镜时画的就是上传那张（读回链路本身没歪）',
      dist(P_none, expNone) <= TOL, `画布 ${P_none.join(',')} vs 图上 ${P255.join(',')}`)

    // ★ 断言 6：点下去之后**不碰任何别的东西**，只等画面自己变。
    const before6 = P_none
    await tile(page, '红蓝对调').click()
    const w6 = await waitPixel(page, (p) => dist(p, before6) > TOL)
    check('6', '选中一个滤镜、不碰别的，画面自己变了（cube 异步到手）',
      !!w6, w6 ? `${w6.ms}ms 后 ${before6.join(',')} → ${w6.px.join(',')}` : '等了 10 秒画面一动不动')
    const P_100 = w6?.px ?? (await pixel(page))

    const expSwap = expect255(cubeOf('红蓝对调'), P255, 100)
    const swapped = dist([P_100[0], P_100[1], P_100[2]], [before6[2], before6[1], before6[0]]) <= TOL
    check('2', '方向：红蓝对调的表确实把 R/B 换了，且与 CPU 对得上',
      dist(P_100, expSwap) <= TOL && swapped,
      `画布 ${P_100.join(',')} / CPU 期望 ${expSwap.join(',')}（原像素 ${before6.join(',')}）`)

    // 断言 1b：强度 100 与"不用"必须不同（可感知）。
    check('1b', '强度 100 与「不用」明显不同',
      dist(P_100, P_none) > TOL, `${P_100.join(',')} vs ${P_none.join(',')}（差 ${dist(P_100, P_none)}）`)

    // 断言 3：强度 50。
    const set50 = await setLutAmount(page, 50)
    const w50 = await waitPixel(page, (p) => dist(p, P_100) > TOL)
    const P_50 = w50?.px ?? (await pixel(page))
    const exp50 = expect255(cubeOf('红蓝对调'), P255, 50)
    const between = [0, 1, 2].every((i) =>
      Math.min(P_none[i]!, P_100[i]!) - TOL <= P_50[i]! && P_50[i]! <= Math.max(P_none[i]!, P_100[i]!) + TOL)
    check('3', '强度 50 落在两者之间，且与 CPU 对得上',
      dist(P_50, exp50) <= TOL && between,
      `画布 ${P_50.join(',')} / CPU 期望 ${exp50.join(',')}（滑块${set50}）`)

    // 断言 1a：强度 0 逐字节相同。
    const set0 = await setLutAmount(page, 0)
    const w0 = await waitPixel(page, (p) => dist(p, P_50) > TOL)
    const P_zero = w0?.px ?? (await pixel(page))
    check('1a', '强度 0 与「不用」**逐字节相同**',
      P_zero[0] === P_none[0] && P_zero[1] === P_none[1] && P_zero[2] === P_none[2],
      `${P_zero.join(',')} vs ${P_none.join(',')}（滑块${set0}）`)
    await setLutAmount(page, 100)
    await waitPixel(page, (p) => dist(p, P_zero) > TOL)

    // 断言 4：顺序。先换强非线性的表，再把「亮度」拉到 +40。
    await tile(page, '铁曲线').click()
    await waitPixel(page, (p) => dist(p, P_100) > TOL)
    const expOrder = expect255(cubeOf('铁曲线'), P255, 100, { ...ZERO, exposure: 40 })
    const setB = await setSlider(page, '亮度', 40)
    const wOrder = await waitPixel(page, (p) => dist(p, expOrder) <= TOL)
    const P_order = wOrder?.px ?? (await pixel(page))
    check('4', '顺序：亮度 +40 之后套表 == applyLut(cube, applyTone(px, …))',
      dist(P_order, expOrder) <= TOL,
      `画布 ${P_order.join(',')} / CPU 期望 ${expOrder.join(',')}（亮度滑块${setB}）`)

    // 截图（清单第 12 条）：微调区「滤镜」那栏展开的样子。趁现在格子开着、强度滑块也在。
    await shot(page, '4-adjust-lut-section')
    await page.locator('.panel').screenshot({ path: join(SHOTS, '5-adjust-panel.png') })
    console.log('   📷 5-adjust-panel.png')

    // 亮度回 0 —— 断言 5 和 F5 都要在"只有滤镜"的状态下量。
    await setSlider(page, '亮度', 0)
    await waitPixel(page, (p) => dist(p, P_order) > TOL)

    // 断言 5：domain≠[0,1] + 半格校正。
    await page.waitForTimeout(1400)          // 让亮度那一下的落盘（800ms 防抖）先走完
    const putP = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && /\/api\/sessions\/\d+$/.test(r.url()),
      { timeout: 12_000 }).then(() => true, () => false)
    await tile(page, '半格表').click()
    const expDom = expect255(cubeOf('半格表'), P255, 100)
    const wDom = await waitPixel(page, (p) => dist(p, expDom) <= TOL)
    const P_dom = wDom?.px ?? (await pixel(page))
    check('5', 'domain≠[0,1] 的表：像素与 CPU 对得上（钉住半格校正 + domain 换算）',
      dist(P_dom, expDom) <= TOL,
      `画布 ${P_dom.join(',')} / CPU 期望 ${expDom.join(',')}`)

    // ── 3. 断言 7：F5 之后滤镜还在 ─────────────────────────────────────
    console.log('\n── 3. F5（会话恢复）')
    const putOk = await putP
    console.log(`   ${putOk ? '落盘 PUT 回来了' : '⚠️ 没等到落盘的 PUT'}`)
    await page.waitForTimeout(400)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('canvas.canvas', { timeout: 15_000 })
    const wF5 = await waitPixel(page, (p) => dist(p, expDom) <= TOL, 15_000)
    const P_f5 = wF5?.px ?? (await pixel(page))
    const f5same = dist(P_f5, P_dom) <= TOL
    check('7', 'F5 之后滤镜还在：画布画的仍是带滤镜的结果',
      !!wF5 && f5same && dist(P_f5, P_none) > TOL,
      `刷新后 ${P_f5.join(',')} / 刷新前 ${P_dom.join(',')} / CPU 期望 ${expDom.join(',')}` +
      (wF5 ? `（${wF5.ms}ms 到位）` : '（15 秒没等到带滤镜的画面）'))
    await shot(page, '6-after-f5')

    // ── 4. 说话那条路（8 / 9 / 10 / 11）────────────────────────────────
    console.log('\n── 4. 对话那条路（假决策；/api/edit 全程拦着）')
    await nav(page, '修图').click()
    await page.waitForSelector('.chat', { timeout: 10_000 })
    const editCallsBeforeChat = editCalls.length

    // 断言 8：「用黄昏那个滤镜」→ 格子亮、画面变。
    decision = {
      route: 'params', paramDeltas: {}, reply: '好，给你套上黄昏。', editPrompt: '',
      needsDisambiguation: false, degraded: false, lut: { name: '黄昏', amount: 100 },
    }
    const before8 = await pixel(page)
    await page.fill('input[name="text"]', '用黄昏那个滤镜')
    await page.press('input[name="text"]', 'Enter')
    await page.locator('.bubble.assistant', { hasText: '好，给你套上黄昏。' }).waitFor({ timeout: 10_000 })
    const w8 = await waitPixel(page, (p) => dist(p, before8) > TOL)
    const P_chat = w8?.px ?? (await pixel(page))
    // 打开对话区那颗按钮，看格子上亮的是哪一个。
    await page.locator('.chat-lut-btn').click()
    await page.waitForSelector('.chat-lut .lut-picker .lut-tile', { timeout: 10_000 })
    const lit8 = await litTile(page)
    await shot(page, '7-chat-lut')
    await page.locator('.chat').screenshot({ path: join(SHOTS, '8-chat-panel.png') })
    console.log('   📷 8-chat-panel.png')
    const expDusk = expect255(cubeOf('黄昏'), P255, 100)
    check('8', '「用黄昏那个滤镜」→ 格子上亮起黄昏、画面变（和 CPU 对得上）',
      lit8 === '黄昏' && dist(P_chat, expDusk) <= TOL && dist(P_chat, before8) > TOL,
      `亮的格子「${lit8}」，画布 ${before8.join(',')} → ${P_chat.join(',')} / CPU 期望 ${expDusk.join(',')}`)

    // 断言 9：「不要滤镜了」→ 回到「不用」。
    decision = {
      route: 'params', paramDeltas: {}, reply: '好，撤掉滤镜。', editPrompt: '',
      needsDisambiguation: false, degraded: false, lut: { name: '', amount: 100 },
    }
    await page.fill('input[name="text"]', '不要滤镜了')
    await page.press('input[name="text"]', 'Enter')
    await page.locator('.bubble.assistant', { hasText: '好，撤掉滤镜。' }).waitFor({ timeout: 10_000 })
    await waitPixel(page, (p) => dist(p, P_chat) > TOL)
    const P_off = await pixel(page)
    const lit9 = await litTile(page)
    check('9', '「不要滤镜了」→ 回到「不用」（像素逐字节回到没滤镜那一次）',
      lit9 === '不用' && dist(P_off, P_none) === 0,
      `亮的格子「${lit9}」，画布 ${P_off.join(',')} vs 没滤镜时 ${P_none.join(',')}`)

    // 断言 10：只调滤镜的这两句话，一次都不许碰 /api/edit（钱闸）。
    check('10', '只调滤镜的那两句话：/api/edit 一次都没被调用',
      editCalls.length === editCallsBeforeChat,
      `这一段里 /api/edit 被请求了 ${editCalls.length - editCallsBeforeChat} 次（累计 ${editCalls.length}）`)

    // 断言 11：同一次决策"既生成又换滤镜" → 「回到这一步」滤镜跟着回来。
    decision = {
      route: 'both', paramDeltas: {}, reply: '好，把背景换成傍晚。', editPrompt: 'make the background evening',
      needsDisambiguation: false, degraded: false, lut: { name: '黄昏', amount: 100 },
    }
    editMode = 'fake'
    await page.fill('input[name="text"]', '把背景换成傍晚')
    await page.press('input[name="text"]', 'Enter')
    await page.locator('.bubble.assistant', { hasText: '好，把背景换成傍晚。' }).waitFor({ timeout: 15_000 })
    // 等 busy 收工（气泡消失）+ 画面换成新底图
    await page.waitForFunction(() => !document.querySelector('.bubble.pending'), null, { timeout: 15_000 })
    const w11 = await waitPixel(page, (p) => dist(p, expDusk) <= TOL || dist(p, FAKE255) <= TOL, 15_000)
    const P_gen_with = w11?.px ?? (await pixel(page))
    const expGenWith = expect255(cubeOf('黄昏'), FAKE255, 100)
    check('11a', '「既生成又换滤镜」：新底图带着新滤镜画出来（不是旧底图也不是没滤镜）',
      dist(P_gen_with, expGenWith) <= TOL && dist(P_gen_with, P_off) > TOL,
      `画布 ${P_gen_with.join(',')} / CPU 期望 ${expGenWith.join(',')}（假底图 ${FAKE255.join(',')}）`)

    // 先把滤镜摘掉（画面回到"假底图 + 没滤镜"）……
    await tile(page, '不用').click()
    await waitPixel(page, (p) => dist(p, P_gen_with) > TOL)
    const P_gen_off = await pixel(page)
    // ……再点那一步的「回到这一步」——滤镜必须跟着回来。
    await page.locator('.bubble.assistant', { hasText: '好，把背景换成傍晚。' })
      .locator('.bubble-jump').click()
    await waitPixel(page, (p) => dist(p, P_gen_off) > TOL)
    const P_gen_back = await pixel(page)
    const lit11 = await litTile(page)
    check('11b', '点那一步的「回到这一步」→ 滤镜跟着回来（格子和画面都对上）',
      dist(P_gen_back, P_gen_with) <= TOL && lit11 === '黄昏' && dist(P_gen_off, P_gen_back) > TOL,
      `摘掉后 ${P_gen_off.join(',')} → 跳回后 ${P_gen_back.join(',')}（那一步是 ${P_gen_with.join(',')}），` +
      `亮的格子「${lit11}」`)
    check('11c', '这一条真的只打了一次图像模型（假的那次）',
      editCalls.length === editCallsBeforeChat + 1,
      `累计 /api/edit ${editCalls.length} 次`)
  } finally {
    await browser.close()
  }
}

// ── 跑起来：异常也照样把表打完整 ────────────────────────────────────────
try {
  await main()
} catch (e) {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  console.error('\n💥 探针自己崩了：', msg)
  rows.push({ id: 'CRASH', what: '探针中途崩了（上面那几行之后全没跑）', got: msg, ok: false })
}

console.log('\n╔══ 结果表 ══════════════════════════════════════════════════════════')
const wWhat = Math.max(8, ...rows.map((r) => [...r.what].length))
for (const r of rows) {
  // 按字符宽对齐（中文算两格）—— 尽力而为，读得顺就行
  const pad = ' '.repeat(Math.max(0, wWhat - [...r.what].length))
  console.log(`║ ${r.id.padEnd(9)} ${r.ok ? '✅' : '❌'} ${r.what}${pad}  ${r.got}`)
}
const bad = rows.filter((r) => !r.ok)
console.log('╚════════════════════════════════════════════════════════════════════')
if (bad.length > 0) {
  console.log(`\n❌ ${bad.length} / ${rows.length} 条不过。`)
  console.log('   期望值全部来自 src/core/lut.ts 的 applyLut（CPU 对照）—— 红的那条要么是')
  console.log('   shader 和它走岔了，要么是顺序/强度/半格/domain 这四件事之一。')
  process.exit(1)
}
console.log(`\n✅ 滤镜渲染与说话那条路全过（${rows.length} 条断言，零模型调用）`)
