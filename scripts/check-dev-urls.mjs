/**
 * 检查：前端每个源文件，在 dev 服务器上都拿得到**真身**。
 *
 * 为什么要留这条检查 —— vite 的 root 是仓库根，所以前端文件按 URL 直接提供
 * （`src/api/client.ts` → `/src/api/client.ts`）；而 vite 的 proxy 又占着 `/api`
 * 这个前缀。**两者可能撞**：模块被转发给后端、拿回 404，React 挂不上、页面全白。
 *
 * 2026-09-22 真撞过一次（当时前端根目录下有个 `api/` 文件夹），而且：
 *   - 214 条测试全绿（它们把网络那一层假掉了）
 *   - typecheck 全绿
 *   - vite build 全绿（**构建走文件系统、不经过 dev 服务器，看不见这个撞车**）
 *   - curl 首页和 /main.tsx 也都是 200
 * 最后是用户自己打开页面才发现的。这是目前唯一能看见这类撞车的东西。
 *
 * ⚠️ 两个坑，都是这个脚本自己踩过的：
 *   1. 网址要以 **vite 的 root（仓库根）** 为基准，不是以 src/ 为基准 ——
 *      算错会得出 `/api/client.ts` 这种根本不对的路径。
 *   2. **光看 200 不够**：vite 会把找不到的路径兜底成 index.html，那也是 200。
 *      所以还要确认拿回来的不是那个 HTML —— 否则脚本会满屏绿灯地骗你。
 *
 * 用法（需要 dev 服务器开着）：
 *   npm run dev            # 或者双击「RuiXing 启动」
 *   node scripts/check-dev-urls.mjs
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const BASE = process.env.DEV_BASE ?? 'http://localhost:5173'
/** 走哪些目录（前端源码） */
const WALK = 'src'
/** 算网址的基准 —— 必须是 vite 的 root */
const URL_ROOT = '.'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

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

const files = walk(WALK)
let bad = 0
for (const f of files) {
  const url = `${BASE}/${relative(URL_ROOT, f).split(sep).join('/')}`
  let res
  try {
    res = await fetch(url)
  } catch {
    console.log(`❌ 连不上 ${BASE} —— dev 服务器开着吗？`)
    process.exitCode = 1
    break
  }
  const isHtml = (res.headers.get('content-type') ?? '').includes('text/html')
  if (res.status !== 200 || isHtml) {
    bad++
    console.log(`❌ ${res.status}${isHtml ? '（拿回来的是首页 HTML，不是模块）' : ''}  ${url}`)
  }
}

console.log('')
if (bad) {
  console.log(`${bad} / ${files.length} 个前端文件拿不到真身。`)
  console.log('多半是路径被什么挡住了 —— 去 vite.config.ts 看 proxy 的前缀或 fs.deny')
  console.log('是不是把 src/ 下面某个文件夹盖住了（历史上撞过 `/api`）。')
  // 用 exitCode 而不是 process.exit()：后者会在还有请求在飞的时候硬退，
  // 于是真正的报错后面会跟一句 libuv 的 Assertion failed，看着像崩了。
  process.exitCode = 1
} else {
  console.log(`✅ ${files.length} 个前端文件全部拿得到真身（不是兜底首页）`)
}
