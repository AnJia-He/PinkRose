// 真实 API 冒烟。**会花钱**——一次生成约 12,900 tokens，手动跑，不进 CI。
// 用法：先 `node server/index.ts`，再 `node scripts/smoke.mjs`
// 加 `--with-edit` 才打 /images/edits（那一步约 12,900 tokens，跑一次就够）。
//
// ⚠️ 这个脚本是**会红的**：任何一条断言失败，进程以非 0 退出。
// 「打印一行 ❌ 然后 exit 0」等于没有断言——本仓库已经栽过八次，
// 断言必须真的咬得住，所以下面每一条都进了 failures 数组、都影响退出码。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787'
const IMG = resolve('spike/evidence/real_1027.jpg')
const WANT_EDIT = process.argv.includes('--with-edit')

const t0 = () => performance.now()
const secs = (t) => ((performance.now() - t) / 1000).toFixed(1)

// ---- 断言与警告 ----
const failures = []
const warnings = []

/** 记录一条硬断言。失败会进 failures，最终决定退出码。 */
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`     ✅ ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`     ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 软警告：记下来，但**不改退出码**（比如卡片文案超了 prompt 里 12 字的要求）。 */
function warn(name) {
  warnings.push(name)
  console.log(`     ⚠️ ${name}`)
}

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
const get = (path) => req('GET', path)

const dataUrl = `data:image/jpeg;base64,${(await readFile(IMG)).toString('base64')}`
const ZERO = { exposure: 0, contrast: 0, highlights: 0, shadows: 0,
               saturation: 0, temperature: 0, clarity: 0, vignette: 0 }

console.log(`底图 ${IMG}\n`)

// ---- 1. 健康检查 ----
// brief 里这行写的是 post('/api/health', {})，但 server/app.ts 只注册了
// **GET** /api/health（POST 会落到 404「没有这个接口」）。计划文档自己的
// 实现（docs/.../2026-09-22-conversational-editing.md:792）和它自己的两处
// curl 校验（同文件 997 / 4220）用的都是 GET，所以这是 brief 的一处笔误。
// 这里用 GET——它验的是「服务活着吗」，方法写错只会得到一个假警报。
let t = t0()
const health = await get('/api/health')
console.log(`1. /api/health          ${health.status}  ${secs(t)}s  ${JSON.stringify(health.json)}`)
check('健康检查 200 且 ok=true', health.status === 200 && health.json?.ok === true,
  `实际 status=${health.status} body=${JSON.stringify(health.json)}`)

// ---- 2. 建议卡片 ----
t = t0()
const sug = await post('/api/suggest', { imageDataUrl: dataUrl })
console.log(`2. /api/suggest         ${sug.status}  ${secs(t)}s  degraded=${sug.json.degraded}`)
const cards = sug.json.cards ?? []
check('建议卡片 200', sug.status === 200, `实际 status=${sug.status}`)
check('拿到了至少 1 张卡片', cards.length > 0, `实际 ${cards.length} 张`)
check('卡片没有降级（degraded=false）', sug.json.degraded === false,
  'degraded=true 说明模型没按约定形状答，卡片是空壳')
for (const c of cards) {
  const len = [...c.label].length
  console.log(`     [${c.route}] ${c.label}  (${len} 字)  deltas=${JSON.stringify(c.paramDeltas)}`)
  if (len > 12) warn(`卡片「${c.label}」${len} 字，超过 prompt 要求的 12 字`)
  if (c.editPrompt) console.log(`       edit_prompt=${JSON.stringify(c.editPrompt.slice(0, 120))}`)
}

// ---- 3. 纯调色（零成本断言）----
// ★ 这是整个脚本最重要的一条：「调色零成本」是这个产品形态的地基。
// 如果「天太灰了」走了生成，说明意图路由把一句纯调色送进了 12,900 tokens
// 的生成，成本模型就垮了。
t = t0()
const r1 = await post('/api/route', { imageDataUrl: dataUrl, text: '天太灰了', params: ZERO })
const d1 = r1.json.decision
console.log(`\n3. "天太灰了"           ${r1.status}  ${secs(t)}s`)
console.log(`     route=${d1?.route}  deltas=${JSON.stringify(d1?.paramDeltas)}`)
console.log(`     reply=${d1?.reply}`)
check('纯调色路由 200', r1.status === 200, `实际 status=${r1.status}`)
check('走参数路 = 零成本', d1?.route === 'params', `本该走参数路，实际走 ${d1?.route}`)
check('给的确实是调色增量（非空 deltas）',
  Object.values(d1?.paramDeltas ?? {}).some(v => v !== 0),
  `deltas=${JSON.stringify(d1?.paramDeltas)}`)
check('没有降级（degraded=false）', d1?.degraded === false,
  'degraded=true 说明这是降级路径，不是模型真听懂了')

// ---- 4. 纯生成 ----
t = t0()
const r2 = await post('/api/route', { imageDataUrl: dataUrl, text: '把后面那个人去掉', params: ZERO })
const d2 = r2.json.decision
console.log(`\n4. "把后面那个人去掉"   ${r2.status}  ${secs(t)}s`)
console.log(`     route=${d2?.route}  degraded=${d2?.degraded}  edit_prompt=${JSON.stringify(d2?.editPrompt?.slice(0, 120))}`)
check('纯生成路由 200', r2.status === 200, `实际 status=${r2.status}`)
check('走生成路', d2?.route === 'generate', `实际走 ${d2?.route}`)
// 这条不光是格式检查：第 6 项靠 editPrompt 才能跑，空的会让 --with-edit 静默变空转
check('给了非空 edit_prompt（第 6 项的前提）', Boolean(d2?.editPrompt?.trim()),
  'editPrompt 为空，--with-edit 会无事可做')

// ---- 5. 多意图 ----
t = t0()
const r3 = await post('/api/route', { imageDataUrl: dataUrl, text: '天太灰了，人再亮点，把后面那个人去掉', params: { ...ZERO, temperature: -30 } })
const d3 = r3.json.decision
console.log(`\n5. 三合一（且已调过色温-30）  ${r3.status}  ${secs(t)}s`)
console.log(`     route=${d3?.route}（期望 both）  degraded=${d3?.degraded}  deltas=${JSON.stringify(d3?.paramDeltas)}`)
console.log(`     reply=${d3?.reply}`)
console.log(`     edit_prompt=${JSON.stringify(d3?.editPrompt)}`)
check('三合一路由 200', r3.status === 200, `实际 status=${r3.status}`)
check('走 both（参数 + 生成都要）', d3?.route === 'both', `实际走 ${d3?.route}`)
check('both 的两半都给了（deltas 与 edit_prompt 皆非空）',
  Object.values(d3?.paramDeltas ?? {}).some(v => v !== 0) && Boolean(d3?.editPrompt?.trim()),
  `deltas=${JSON.stringify(d3?.paramDeltas)} editPrompt=${JSON.stringify(d3?.editPrompt?.slice(0, 80))}`)

// ---- 6. 生成式编辑（**这一步花钱**）----
if (WANT_EDIT && d2?.editPrompt) {
  t = t0()
  const ed = await post('/api/edit', {
    imageDataUrl: dataUrl, editPrompt: d2.editPrompt, width: 1216, height: 800,
  })
  console.log(`\n6. /api/edit            ${ed.status}  ${secs(t)}s  ` +
    (ed.json.imageDataUrl ? `输出 ${Math.round(ed.json.imageDataUrl.length / 1024)} KB` : JSON.stringify(ed.json)))
  check('生成式编辑 200', ed.status === 200, `实际 status=${ed.status}`)
  check('回来了图片数据', typeof ed.json.imageDataUrl === 'string' && ed.json.imageDataUrl.startsWith('data:image/'),
    `实际 ${JSON.stringify(ed.json).slice(0, 200)}`)
  check('回图尺寸与请求一致（1216x800）',
    ed.json.width === 1216 && ed.json.height === 800,
    `实际 ${ed.json.width}x${ed.json.height}`)
  // 把结果存下来供肉眼比对（test-photos/ 已在 .gitignore 排除）
  if (ed.json.imageDataUrl) {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir('test-photos', { recursive: true })
    await writeFile('test-photos/smoke_edit.png',
      Buffer.from(ed.json.imageDataUrl.split(',')[1], 'base64'))
    console.log('     已存到 test-photos/smoke_edit.png')
  }
} else if (WANT_EDIT) {
  // 显式说了要花钱跑生成，却因为第 4 项没给 prompt 而跑不了 —— 这必须响亮地失败，
  // 不能退化成 brief 里那句「跳过（加 --with-edit 才跑）」，那是**假话**：
  // 用户确实加了 --with-edit。
  console.log('\n6. /api/edit            ❌ 无法运行')
  check('--with-edit 能真的跑起来', false, '第 4 项没给出 edit_prompt，这一项无从执行')
} else {
  console.log('\n6. /api/edit            跳过（加 --with-edit 才跑，它会花钱）')
}

// ---- 汇总 ----
console.log('\n' + '─'.repeat(60))
if (warnings.length) {
  console.log(`⚠️  ${warnings.length} 条警告：`)
  for (const w of warnings) console.log(`     - ${w}`)
}
if (failures.length) {
  console.log(`❌ ${failures.length} 条断言失败：`)
  for (const f of failures) console.log(`     - ${f}`)
  process.exitCode = 1
} else {
  console.log(`✅ 全部断言通过${warnings.length ? `（另有 ${warnings.length} 条警告）` : ''}`)
}
