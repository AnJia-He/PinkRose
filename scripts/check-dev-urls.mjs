/**
 * 检查：前端每个源文件，在 dev 服务器上都拿得到（HTTP 200）。
 *
 * 为什么要留这条检查 —— vite 的 root 现在是 `HeadEnd/`，所以前端文件是按 URL
 * 直接提供的（`HeadEnd/net/client.ts` → `/net/client.ts`）；而 vite 的 proxy
 * 又占着 `/api` 这个前缀。**两者会撞**：只要有人在 `HeadEnd/api/` 放东西，
 * 那些模块就会被代理转发给后端、拿回 404，React 挂不上、**页面全白**。
 *
 * 2026-09-22 真撞过一次，而且：
 *   - 214 条测试全绿（它们把网络那一层假掉了）
 *   - typecheck 全绿
 *   - vite build 全绿（**构建走文件系统、不经过 dev 服务器，看不见这个撞车**）
 *   - curl 首页和 /main.tsx 也都是 200
 * 最后是用户自己打开页面才发现的。所以留这条检查 —— 它是唯一能看见它的东西。
 *
 * 用法（需要 dev 服务器开着）：
 *   npm run dev            # 或者双击「RuiXing 启动」
 *   node scripts/check-dev-urls.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const BASE = process.env.DEV_BASE ?? 'http://localhost:5173'
const ROOT = 'HeadEnd'
// BackEnd 是后端，不在前端的模块图里（而且 vite 的 fs.deny 故意挡着它）
const SKIP_DIRS = new Set(['BackEnd', 'dist', 'node_modules'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out)
    } else {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const files = walk(ROOT)
let bad = 0
for (const f of files) {
  const url = `${BASE}/${relative(ROOT, f).split(sep).join('/')}`
  let status
  try {
    status = (await fetch(url)).status
  } catch {
    console.log(`❌ 连不上 ${BASE} —— dev 服务器开着吗？`)
    process.exit(1)
  }
  if (status !== 200) {
    bad++
    console.log(`❌ ${status}  ${url}`)
  }
}

console.log('')
if (bad) {
  console.log(`${bad} / ${files.length} 个前端文件拿不到。`)
  console.log('多半是路径被什么挡住了 —— 去 vite.config.ts 看看 proxy 的前缀')
  console.log('是不是和 HeadEnd/ 下面某个文件夹重名了（历史上撞过 `/api`）。')
  // 用 exitCode 而不是 process.exit()：后者会在还有请求在飞的时候硬退，
  // 于是真正的报错后面会跟一句 libuv 的 Assertion failed，看着像崩了。
  process.exitCode = 1
} else {
  console.log(`✅ ${files.length} 个前端文件全部拿得到`)
}
