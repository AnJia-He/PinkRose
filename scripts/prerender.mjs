/**
 * ★ 2026-10-04：把**落地页**预渲染成静态 HTML，塞进 `dist/index.html`。
 *
 * 为什么要有它 —— 门面是纯客户端渲染的，`curl http://…/` 返回的正文是
 * **0 个字**（实测：4795 字节全是脚本和标签）。爬虫不跑 JS（社交软件的抓取器、
 * 各家 AI 爬虫、搜索引擎都算），它们看到的就是一张白纸 —— 等于这个产品
 * 对搜索引擎不存在。`index.html` 里那句注释写的"那件事要预渲染才能解，还没做"
 * 说的就是这一步。
 *
 * 两步：
 *   ① 一份 **SSR 构建**（vite 的 JS API + `build.ssr`）把落地页渲成 HTML 片段。
 *      资源和客户端那份走**同一套 hash 命名**，所以片段里引的图/字体和
 *      客户端构建产出的文件是同一个 URL（下面 ③ 会逐个核对，对不上就失败）。
 *   ② 改 `dist/index.html`：**先把原样的存一份 `dist/app.html`**（给 /app 用），
 *      再把片段塞进 `#root`，并给 `<html>` 加上 `lp-on`（落地页那几条文档级的
 *      规则——body 底色 / color-scheme / 滚动条——靠这个类生效，见 landing.css
 *      末尾；不加的话爬虫拿到的那份连底色都是错的）。
 *
 * 为什么 `/app` 要用**空壳**那一份（见 `server/app.ts` 的分发）：
 *   index.html 现在是"落地页已经在里面"的版本，App 那几屏要是也吃它，
 *   用户会先看到一帧落地页的内容、再被 React 清掉 —— 那是新的闪屏。
 *
 * ⚠️ 渲染出来的是**静态 HTML**：React 挂载时（createRoot）会把 `#root` 清空
 *   重画 —— 同一帧里完成，看不出闪。爬虫读的是清空前的那一份，两全。
 */
import { build } from 'vite'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')
const TMP = join(ROOT, 'dist-prerender')

const INDEX = join(DIST, 'index.html')
if (!existsSync(INDEX)) {
  console.error('dist/index.html 不在 —— 这个脚本接在 `vite build` 后面跑（见 package.json 的 build）')
  process.exit(1)
}

// ① SSR 构建（产物是临时的，渲完就删）
await build({
  root: ROOT,
  logLevel: 'warn',
  build: { ssr: join(ROOT, 'scripts', 'prerender-entry.tsx'), outDir: TMP, emptyOutDir: true },
})

const mod = await import(pathToFileURL(join(TMP, 'prerender-entry.js')).href)
const markup = mod.renderLanding()
if (!markup || markup.length < 2000) {
  console.error(`渲染出来的片段只有 ${markup?.length ?? 0} 个字符 —— 落地页不可能这么短，八成坏了`)
  process.exit(1)
}

// ② 存档空壳 + 注入
const shell = readFileSync(INDEX, 'utf8')
writeFileSync(join(DIST, 'app.html'), shell)

const injected = shell
  .replace('<html lang="zh-CN">', '<html lang="zh-CN" class="lp-on">')
  .replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
if (injected === shell || !injected.includes('class="lp-on"')) {
  // 形状对不上就**当场停**：静默跳过的话，dist 里是一份"看起来构建成功、
  // 其实正文还是 0 个字"的文件 —— 这个仓库最贵的那类坑。
  console.error('没能在 index.html 里找到 <html lang="zh-CN"> / <div id="root"></div> —— 模板的形状变了？')
  process.exit(1)
}
writeFileSync(INDEX, injected)

// ③ 自查：片段里引的每个 /assets/xxx 都必须在 dist 里真存在。
//   SSR 构建和客户端构建的 hash 规则理论上是同一套 —— 但这事**只在运行时看得出来**：
//   对不上的话页面上的图全 404，而 build 一声不吭。
const refs = [...new Set([...injected.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]))]
const missing = refs.filter((r) => !existsSync(join(DIST, r)))
if (missing.length) {
  console.error('预渲染引用的这些文件不在 dist 里（两边的 hash 规则对不上？）：')
  for (const m of missing) console.error('  ' + m)
  process.exit(1)
}

rmSync(TMP, { recursive: true, force: true })
console.log(
  `落地页预渲染完成：正文片段 ${markup.length} 字符进了 dist/index.html（引用 ${refs.length} 个资源，全都在）· 空壳存为 dist/app.html`,
)
