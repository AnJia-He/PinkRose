/**
 * 界面 ↔ 网址的对应关系。**规则只有这一份。**
 *
 * ⚠️ 详情页的网址里用 **id** 不用名字（§3.5.1）：名字能改，改完链接就失效；
 * 中文名还会被转义成一长串 `%E4%B8%AD%...`。页面上显示的**仍然是名字**，
 * 只是地址栏里是 id。
 *
 * ★ 2026-09-30 起分了两层：
 *   · **`/` 是落地页**（门面，访客先看到它）；
 *   · **App 住在 `/app` 底下**（修图 / 作品 / 详情）。
 *   已经登录的人打开 `/` 会被送去 `/app`（见 App.tsx 里那个 replace 跳转）——
 *   营销页是给访客看的，自己人每次打开都撞上它是打扰。
 *
 * ⚠️ **老网址照旧认**：`/works`、`/works/7` 是分家之前那一版的形态，
 * 用户手里可能有旧书签。它们只是"认得出来"——真走过去之后，`App` 的 `go()`
 * 会把地址栏改写成 `/app/...` 那一套（一次导航就搬过去了）。
 *
 * 认不出来的路径**退回落地页**（= `/`）—— 首页是那种情况下的标准答案，
 * 而白屏是最差的答案。**登录着的人不会因此被关在营销页上**：
 * 落地页那一条会立刻把他们送去 `/app`。
 */
export type View =
  | { kind: 'landing' }
  | { kind: 'edit' }
  | { kind: 'gallery' }
  | { kind: 'work'; id: number }
  // 用户管理（§3.6）。收在右上角那颗 👤 后面（§3.2）—— 一辈子点几次，不占一级导航
  | { kind: 'account' }
  // 模型设置（§7.4）。**挂在用户管理底下**：从那一页的「模型」那一行进去，
  // 和 §3.6 那张图长的一样 —— 它不是一级导航，是设置里的一格。
  | { kind: 'models' }

/** App 的地盘。写在这儿是为了让"它挪过窝"这件事只有一处要说。 */
const APP = '/app'

export function viewFromPath(path: string): View {
  // 详情页：新老两种形态都认
  const m = /^\/works\/(\d+)$/.exec(path) ?? /^\/app\/works\/(\d+)$/.exec(path)
  if (m) return { kind: 'work', id: Number(m[1]) }
  if (path === '/works' || path === `${APP}/works`) return { kind: 'gallery' }
  if (path === `${APP}/account`) return { kind: 'account' }
  // 模型设置也可以直接打开（F5、收藏、别人发来的一条链接）——
  // 少认这一行，用户按 F5 就被扔回修图页，而他明明还在这页上。
  if (path === `${APP}/models`) return { kind: 'models' }
  if (path === APP) return { kind: 'edit' }
  if (path === '/') return { kind: 'landing' }
  return { kind: 'landing' }
}

export function pathOf(v: View): string {
  if (v.kind === 'landing') return '/'
  if (v.kind === 'gallery') return `${APP}/works`
  if (v.kind === 'work') return `${APP}/works/${v.id}`
  if (v.kind === 'account') return `${APP}/account`
  if (v.kind === 'models') return `${APP}/models`
  return APP
}
