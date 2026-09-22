// 真实 API 冒烟。**会花钱**——一次生成约 12,900 tokens，手动跑，不进 CI。
// 用法：先 `node HeadEnd/BackEnd/index.ts`，再 `node scripts/smoke.mjs`
// 加 `--with-edit` 才打 /images/edits（那一步约 12,900 tokens，跑一次就够）。
// 但 `--with-edit` **只是三个前提之一**（详见第 6 项）：还要有非空的 edit_prompt，
// 以及模型没说拿不准（needsDisambiguation === false）。最后一条挡的是"模型把一句
// 拒绝语当 prompt 交回来，钱花了而画面一个像素没动"——真发生过一次。
// 生成的结果会落到 `test-photos/smoke_edit.png` 供肉眼比对（该目录已 gitignore）。
//
// ─────────────────────────────────────────────────────────────────────
// 断言语义（裁定 ⑥）：**脚本断言的是我们能控制的东西，报告的是模型的选择。**
//
// 为什么要有这条判据：实测打真实上游的冒烟共 7 次，其中 5 次至少出现一次
// degraded=true，累计 8 次模型调用降级（/api/suggest 2 次、/api/route 6 次，
// 含 1 次退化成 params + 无 deltas 的静默空转、1 次没守 route 枚举）。
// **这看起来是常态，不是偶发。** 对模型的选择下硬断言，等于让脚本在上游一抽风时变红；
// 那是噪声不是信号——一个常态变红的脚本，人就会开始忽略它，它也就死了。
//
// 所以本脚本分成三档：
//   check()  —— 硬断言，**只用于我们能控制的东西**（HTTP 状态码、我们自己的协议）。
//               失败进 failures，最终决定退出码。
//   warn()   —— 软警告，不改退出码。
//   report() —— 如实报告**模型的选择**，给出判读，但**不**决定退出码。
//
// 唯一的例外是第 3 项（见那里的注释）：它是"调色零成本"这个成本模型的地基，
// 对**模型的选择**也保留硬断言——但它会区分"上游抽风"和"我们的代码不对"两种红。
// ─────────────────────────────────────────────────────────────────────
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787'
// 两种底图，各有各的理由：
//   IMG      —— 真照片（1200×800），用来测路由/建议。它不关心尺寸，测的是模型读不读得懂人话。
//   EDIT_IMG —— 1024×768 的示意图，**宽高都是 32 的倍数**，用来测 /api/edit。
//              这一项关心尺寸：请求里声明的 size 必须与送进去的字节完全一致，
//              否则模型会重构构图（实测地平线从 78% 漂到 65%）。
//              原来这里送的是 1200×800 的原始字节却声明 1216×800 —— **声明与实物不符**，
//              这个脚本因此是坏的。换成天然对齐的图，就再也不需要任何缩放处理（本脚本零 canvas）。
const IMG = resolve('spike/evidence/real_1027.jpg')
const EDIT_IMG = resolve('spike/evidence/input_scene.jpg')
const EDIT_W = 1024
const EDIT_H = 768
const WANT_EDIT = process.argv.includes('--with-edit')

const t0 = () => performance.now()
const secs = (t) => ((performance.now() - t) / 1000).toFixed(1)

// ---- 三档记录 ----
const failures = []       // 我们控制的东西坏了 -> 退出码 1
const warnings = []       // 软警告，不改退出码
const observations = []   // 模型的选择，只报告
let editCalls = 0         // 这次跑**实际**发起了几次付费的 /api/edit（裁定 ⑨ 的断言要用）

/** 硬断言：只用于**我们能控制**的东西。 */
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`     ✅ ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`     ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 软警告：记下来，但不改退出码。 */
function warn(name) {
  warnings.push(name)
  console.log(`     ⚠️ ${name}`)
}

/**
 * 如实报告**模型的选择**（裁定 ⑥）：给判读，但不决定退出码。
 * 上游抽风不是我们的代码不对，不该让脚本变红。
 */
function report(name, ok, detail = '') {
  if (ok) {
    console.log(`     ✅ ${name}`)
    return
  }
  observations.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`     ⚠️ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** degraded=true 时统一加的一句判读：这是上游抽风，不是我们的代码不对。 */
const UPSTREAM = '（本次 degraded=true：模型没答上来，**上游抽风**，不是我们的代码不对）'

async function req(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(`${BASE}${path}`, init)
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}
const post = (path, body) => req('POST', path, body)
// 健康检查用 GET：HeadEnd/BackEnd/app.ts 只注册了 GET /api/health（POST 会落到 404）。
// 计划文档自己的实现（docs/.../2026-09-22-conversational-editing.md:792）和它自己的
// 两处 curl 校验（同文件 997 / 4220）用的都是 GET，只有冒烟那一段写成了 post()，
// 是 brief 的笔误。这里验的是「服务活着吗」，方法写错只会得到一个假警报。
const get = (path) => req('GET', path)

/**
 * 读 JPEG 的真实宽高（只扫到 SOF 段为止）。
 * 它存在的理由：本脚本踩过一次「声明的 size 与送进去的字节不符」，
 * 而那正是本计划最关键的实测结论之一。让**实物尺寸**变成一条硬断言，
 * 以后有人换了底图、忘了改声明，这里会当场红，而不是把一次跑歪的生成浪费掉。
 */
function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue }
    const m = buf[i + 1]
    // SOF0..SOF15 就是帧头；跳过 DHT(c4) / JPG(c8) / DAC(cc)
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

const jpegBytes = await readFile(IMG)
const dataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`
const ZERO = { exposure: 0, contrast: 0, highlights: 0, shadows: 0,
               saturation: 0, temperature: 0, clarity: 0, vignette: 0 }

console.log(`底图 ${IMG}  （路由/建议用）`)
console.log(`     生成项用 ${EDIT_IMG} —— ${EDIT_W}×${EDIT_H}，宽高都是 32 的倍数（size 必须与实物一致）\n`)

// ---- 1. 健康检查 ----
let t = t0()
const health = await get('/api/health')
console.log(`1. /api/health          ${health.status}  ${secs(t)}s  ${JSON.stringify(health.json)}`)
check('健康检查 200 且 ok=true', health.status === 200 && health.json?.ok === true,
  `实际 status=${health.status} body=${JSON.stringify(health.json)}`)

// ---- 2. 建议卡片 ----
t = t0()
const sug = await post('/api/suggest', { imageDataUrl: dataUrl })
const cards = sug.json.cards ?? []
console.log(`2. /api/suggest         ${sug.status}  ${secs(t)}s  degraded=${sug.json.degraded}`)
check('建议卡片端点 200', sug.status === 200, `实际 status=${sug.status}`)
// 「有没有卡片」是模型的选择（degraded 的语义就是"模型没按约定形状答"），只报告
report('拿到了至少 1 张卡片', cards.length > 0,
  `实际 ${cards.length} 张${sug.json.degraded ? ' ' + UPSTREAM : ''}`)
report('卡片没有降级（degraded=false）', sug.json.degraded === false,
  'degraded=true 说明模型没按约定形状答，卡片是空壳')
for (const c of cards) {
  const len = [...c.label].length
  console.log(`     [${c.route}] ${c.label}  (${len} 字)  deltas=${JSON.stringify(c.paramDeltas)}`)
  if (len > 12) warn(`卡片「${c.label}」${len} 字，超过 prompt 要求的 12 字`)
  if (c.editPrompt) console.log(`       edit_prompt=${JSON.stringify(c.editPrompt.slice(0, 120))}`)
}

// ---- 3. 纯调色（零成本断言）----
// ★ 全脚本唯一对**模型的选择**保留硬断言的地方：「调色零成本」是这个产品形态的地基。
// 如果「天太灰了」走了生成，一句纯调色会被送进 12,900 tokens 的生成，成本模型就垮了。
// 但它必须能区分**两种红**，因为这两种情况的处理完全不同：
//   a) degraded=true  → 模型根本没答上来（上游抽风）。我们**不能**据此说自己的代码有问题
//                       → 判为"无法判定"，只报告，不改退出码
//   b) degraded=false 但 route≠params → 模型是**老实答的**，却答错了。
//                       那就是我们的提示词 / 校验层有问题 → **硬红**
t = t0()
const r1 = await post('/api/route', { imageDataUrl: dataUrl, text: '天太灰了', params: ZERO })
const d1 = r1.json.decision
console.log(`\n3. "天太灰了"           ${r1.status}  ${secs(t)}s`)
console.log(`     route=${d1?.route}  degraded=${d1?.degraded}  deltas=${JSON.stringify(d1?.paramDeltas)}`)
console.log(`     reply=${d1?.reply}`)
check('纯调色路由 200', r1.status === 200, `实际 status=${r1.status}`)
if (d1?.degraded === true) {
  report('走参数路 = 零成本 —— 本次**无法判定**', false,
    `模型这次没答上来${d1?.route === 'params' && !Object.values(d1?.paramDeltas ?? {}).some(v => v !== 0)
      ? '（退化成 params + 无 deltas 的静默空转）' : ''}，` +
    '这是**上游抽风**，不是"路由把调色送进了生成"。两种情况要分开看，重跑一次再判')
} else {
  check('走参数路 = 零成本', d1?.route === 'params',
    `本该走参数路，实际走 ${d1?.route}；` +
    'degraded=false 说明模型是**老实答的**——那这就是我们的提示词/校验层有问题，不是上游的事')
  report('给的确实是调色增量（非空 deltas）',
    Object.values(d1?.paramDeltas ?? {}).some(v => v !== 0),
    `deltas=${JSON.stringify(d1?.paramDeltas)}`)
}

// ---- 4. 纯生成 ----
t = t0()
const r2 = await post('/api/route', { imageDataUrl: dataUrl, text: '把后面那个人去掉', params: ZERO })
const d2 = r2.json.decision
console.log(`\n4. "把后面那个人去掉"   ${r2.status}  ${secs(t)}s`)
console.log(`     route=${d2?.route}  degraded=${d2?.degraded}  edit_prompt=${JSON.stringify(d2?.editPrompt?.slice(0, 120))}`)
check('纯生成路由 200', r2.status === 200, `实际 status=${r2.status}`)
// 期望值如实标注，但不下硬断言：模型选 generate 还是 params 不是我们能控制的
report('走生成路（期望 generate）', d2?.route === 'generate',
  `实际走 ${d2?.route}${d2?.degraded ? ' ' + UPSTREAM : '（模型老实答的，但没走生成）'}`)
// 下面这句判读必须跟着**实际内容**走，不能只看 degraded。
// degraded=true 并不必然有 prompt：模型可以声明 route=generate 却两半都不给
// （parseDecision 不会走 fallbackDecision，于是 editPrompt 为空）。
// 那种情况下说"prompt 是用户原话"是假的——**下一行打印的 edit_prompt="" 会当场打脸。**
const hasPrompt = Boolean(d2?.editPrompt?.trim())
report('给了非空 edit_prompt（第 6 项的前提）', hasPrompt,
  hasPrompt ? ''
    : d2?.degraded
      ? `prompt 是空的 —— 模型声明了要生成，却两半都不给${UPSTREAM}`
      : '模型没给 edit_prompt，而 degraded=false：是它老实答的，值得看一眼')

// ---- 5. 多意图 ----
t = t0()
const r3 = await post('/api/route', { imageDataUrl: dataUrl, text: '天太灰了，人再亮点，把后面那个人去掉', params: { ...ZERO, temperature: -30 } })
const d3 = r3.json.decision
console.log(`\n5. 三合一（且已调过色温-30）  ${r3.status}  ${secs(t)}s`)
console.log(`     route=${d3?.route}（期望 both）  degraded=${d3?.degraded}  deltas=${JSON.stringify(d3?.paramDeltas)}`)
console.log(`     reply=${d3?.reply}`)
console.log(`     edit_prompt=${JSON.stringify(d3?.editPrompt)}`)
check('三合一路由 200', r3.status === 200, `实际 status=${r3.status}`)
// 裁定 ⑤ 之后，服务端会把「声明 generate 但两半都给了」归一成 both（validate.ts 的 reconcile），
// 所以这一项的期望值现在应当是稳的。仍然只报告不下硬断言——模型的选择不是我们能控制的。
report('走 both（参数 + 生成都要）', d3?.route === 'both',
  `实际走 ${d3?.route}${d3?.degraded ? ' ' + UPSTREAM
    : d3?.route === 'params' ? '（退化成静默空转：既没生成也没参数变化）' : ''}`)
report('both 的两半都给了（deltas 与 edit_prompt 皆非空）',
  Object.values(d3?.paramDeltas ?? {}).some(v => v !== 0) && Boolean(d3?.editPrompt?.trim()),
  `deltas=${JSON.stringify(d3?.paramDeltas)} editPrompt=${JSON.stringify(d3?.editPrompt?.slice(0, 80))}`)

// ---- 6. 生成式编辑（**这一步花钱**）----
// 花钱的前提有三条，缺一条就不调用：
//   ① 命令行显式给了 --with-edit
//   ② 第 4 项给了**非空**的 edit_prompt
//   ③ 模型**没有**说它拿不准 —— needsDisambiguation === false
//
// ③ 是裁定 ⑨ 补的。为什么值得单独拦：本项第一次真跑 --with-edit，模型把**一句拒绝语**
// 放进了 edit_prompt（"No edit - …no other person is visible in this solo portrait"），
// ② 满足，于是钱照花，而结果**一个像素都没变**（像素级实测：差 >32 的像素 0.000%）。
// 前端 App.tsx 一直会拦这种情况；脚本以前不拦，于是那笔钱白花了。
// 这个脚本是项目唯一的上游回归工具，将来会被反复跑，每跑一次都可能在模型拒绝时白烧一次，
// 所以这条拦在脚本里。
// 前提 ② 就是第 4 项报过的那条 hasPrompt（同一个值，不重复算）；这里只补 ③。
const unsure = d2?.needsDisambiguation !== false

if (WANT_EDIT && hasPrompt && !unsure) {
  const editBytes = await readFile(EDIT_IMG)
  const real = jpegSize(editBytes)
  console.log('\n6. /api/edit')
  console.log(`     底图 ${EDIT_IMG}   实物 ${real?.w}×${real?.h}   声明 ${EDIT_W}×${EDIT_H}`)
  console.log(`     prompt 沿用第 4 项（那是对 ${IMG} 的路由结果）。两项底图不同是**有意的**：`)
  console.log('     路由不关心尺寸，只有 /api/edit 关心，所以只有它需要天然对齐的底图。')
  // 先验尺寸再花这笔钱：声明与实物不符时模型会重构构图，跑出来的结果没有意义
  const sizeOk = real !== null && real.w === EDIT_W && real.h === EDIT_H
  check('声明的 size 与底图实物一致（不一致模型会重构构图）', sizeOk,
    real ? `实物 ${real.w}×${real.h}，声明 ${EDIT_W}×${EDIT_H}` : `${EDIT_IMG} 不是能解析的 JPEG`)
  if (sizeOk) {
    t = t0()
    editCalls += 1
    const ed = await post('/api/edit', {
      imageDataUrl: `data:image/jpeg;base64,${editBytes.toString('base64')}`,
      editPrompt: d2.editPrompt, width: EDIT_W, height: EDIT_H,
    })
    console.log(`     响应 ${ed.status}  ${secs(t)}s  ` +
      (ed.json.imageDataUrl ? `输出 ${Math.round(ed.json.imageDataUrl.length / 1024)} KB` : JSON.stringify(ed.json)))
    check('生成式编辑 200', ed.status === 200, `实际 status=${ed.status}`)
    check('回来了图片数据', typeof ed.json.imageDataUrl === 'string' && ed.json.imageDataUrl.startsWith('data:image/'),
      `实际 ${JSON.stringify(ed.json).slice(0, 200)}`)
    check(`回图尺寸与请求一致（${EDIT_W}×${EDIT_H}）`,
      ed.json.width === EDIT_W && ed.json.height === EDIT_H,
      `实际 ${ed.json.width}x${ed.json.height}`)
    // 把结果存下来供肉眼比对（test-photos/ 已在 .gitignore 排除）
    if (ed.json.imageDataUrl) {
      await mkdir('test-photos', { recursive: true })
      await writeFile('test-photos/smoke_edit.png',
        Buffer.from(ed.json.imageDataUrl.split(',')[1], 'base64'))
      console.log('     已存到 test-photos/smoke_edit.png')
    }
  } else {
    console.log('     ⏭  尺寸对不上，跳过这次花钱的调用')
  }
} else if (WANT_EDIT && unsure) {
  // 裁定 ⑨：只报告、不调用。理由要打清楚是"模型拿不准"，不是"没给出 prompt"——
  // 这两种情形以前共用一句含糊的话，读的人会以为是上游抽风抽掉了 prompt。
  console.log('\n6. /api/edit            ⏭  跳过 —— **没有花这笔钱**')
  console.log('     理由：模型自己说它拿不准（needsDisambiguation=true），不是它没给出 prompt。')
  console.log(hasPrompt
    ? `     它同时给了 prompt：${JSON.stringify(d2.editPrompt.slice(0, 120))}`
    : '     而且它也没给出 prompt —— 两个前提都没满足。')
  console.log('     上一个真跑就是这么烧掉 12,900 tokens 的：prompt 非空，但内容是句拒绝语，')
  console.log('     生成出来的图与底图逐像素比对"差 >32"的占比是 0.000%。')
  // 模型拿不准是**模型的选择**，按裁定 ⑥ 只报告、不让脚本变红。
  report('--with-edit 这次没能真的跑起来', false,
    '模型说拿不准（needsDisambiguation=true），脚本按裁定 ⑨ 主动跳过，不是我们的代码坏了。')
} else if (WANT_EDIT) {
  // 显式说了要花钱跑生成，却因为第 4 项没给 prompt 而跑不了。这也要分开看：
  // 成因几乎总是上游抽风（degraded 那次），不是我们的代码不对 -> 只报告
  console.log('\n6. /api/edit            ⚠️ 无法运行')
  report('--with-edit 能真的跑起来', false,
    '第 4 项没给出 edit_prompt，这一项无从执行。' +
    (d2?.degraded ? `成因是上游抽风${UPSTREAM}，不是我们的代码不对，重跑一次通常就有` : '不是降级，值得查一下'))
} else {
  console.log('\n6. /api/edit            跳过（加 --with-edit 才跑，它会花钱）')
}

// 裁定 ⑨ 的断言：**故意放在所有分支之外**。
// 放进上面那个"跳过"分支里的话，将来有人把 needsDisambiguation 这个前提删掉时，
// 断言会跟着分支一起消失 —— 那就又添一处"断言对它命名的事变不了红"。
// 放在这里，前提一旦被删，脚本会真的去调用，这条就红。
if (WANT_EDIT && unsure) {
  check('模型说拿不准时，一次付费调用都不许发', editCalls === 0,
    `第 4 项 needsDisambiguation=${d2?.needsDisambiguation}（拿不准），` +
    `却仍然发起了 ${editCalls} 次 /api/edit`)
}
if (WANT_EDIT && editCalls > 0) {
  check('付费调用没有重复（一次跑最多一次）', editCalls === 1, `实际 ${editCalls} 次`)
}

// ---- 汇总 ----
console.log('\n' + '─'.repeat(64))
console.log('判据（裁定 ⑥）：**断言的是我们能控制的东西，报告的是模型的选择。**')
if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} 条警告（不改退出码）：`)
  for (const w of warnings) console.log(`     - ${w}`)
}
if (observations.length) {
  console.log(`\n⚠️  ${observations.length} 条"模型的选择"不如预期（**不改退出码**，多为上游抽风）：`)
  for (const o of observations) console.log(`     - ${o}`)
}
if (failures.length) {
  console.log(`\n❌ ${failures.length} 条**我们的代码**有问题：`)
  for (const f of failures) console.log(`     - ${f}`)
  process.exitCode = 1
} else {
  console.log(`\n✅ 所有"我们能控制的东西"全部通过`
    + `${observations.length ? `（另有 ${observations.length} 条模型侧的观察，见上，不计入退出码）` : ''}`)
}
