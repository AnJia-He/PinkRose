/**
 * 让 TypeScript 认识 `import logo from './x.svg'`。
 *
 * **为什么不用官方的 `/// <reference types="vite/client" />`：**
 * `tsconfig.json` 里的 `"types": ["vitest/globals"]` 是**故意写窄的** ——
 * 显式列出 types 就等于关掉了"自动加载 node_modules/@types 下全部"。
 * 引 `vite/client` 会顺手把 `import.meta.env`、CSS Modules 那一整套类型也放进来，
 * 而那几样这个项目还没用过：**没用到的东西一旦有了类型，写错了也不会报**。
 * 这里只补真正缺的那一条。
 *
 * ⚠️ Vite 会把 `import x from './a.svg'` 换成一个**网址字符串**，不是组件 ——
 * 所以只能 `<img src={x}>`，不能 `<x />`。想直接当组件用得上 `vite-plugin-svgr`，
 * 而那要新加一个依赖（这个项目的 `dependencies` 只有 piexifjs / react / react-dom，
 * 见 LoginPage 里那颗小眼睛那段注释里同样的取舍）。
 */
declare module '*.svg' {
  const url: string
  export default url
}

/**
 * 同上，位图。**落地页（2026-09-30 搬进仓库）是第一个 import 照片的地方** ——
 * 在它之前，界面上的图只有那个 SVG 标志，其余全是运行时生成的（画布、缩略图、
 * 服务端回图的 data URL），一条 `import ... from './x.jpg'` 都不需要。
 *
 * ⚠️ 和 `.svg` 一样，Vite 给的是一个**网址字符串**（构建时按内容哈希改名、
 * 放进 `assets/`），所以只能 `<img src={x}>`。
 */
declare module '*.jpg' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
