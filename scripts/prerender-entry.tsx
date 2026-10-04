/**
 * 预渲染入口 —— **只在构建时跑一次**（`scripts/prerender.mjs` 用 vite 的 SSR 构建
 * 单独编这一份，然后 node 跑它，把返回的 HTML 片段塞进 dist/index.html）。
 *
 * ⚠️ 它不是应用的一部分：客户端那一次的构建**根本不会包含它**
 *   （vite 只跟着 index.html → main.tsx 的 import 图走，这里没人 import）。
 *   放在 `src/` 下面只有一个理由：它 import 的 `LandingPage` 在这里，而类型检查
 *   要跟着**带 DOM lib** 的那套配置走（`tsconfig.json` 的 include 里有这一行）。
 *
 * ⚠️ `onEnter` 给一个空函数：React 的静态渲染**不产出事件处理器**，落地页那些
 *   `<a href>` 原样留在 HTML 里 —— 爬虫和"没跑 JS 的人"点得动，跑 JS 之后
 *   React 接管，那个 onClick 才会真的生效（见 `main.tsx` 的 createRoot 挂载）。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import LandingPage from '../src/ui/LandingPage'

export function renderLanding(): string {
  return renderToStaticMarkup(<LandingPage onEnter={() => {}} />)
}
