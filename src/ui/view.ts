/**
 * 界面 ↔ 网址的对应关系。**规则只有这一份。**
 *
 * ⚠️ 详情页的网址里用 **id** 不用名字（§3.5.1）：名字能改，改完链接就失效；
 * 中文名还会被转义成一长串 `%E4%B8%AD%...`。页面上显示的**仍然是名字**，
 * 只是地址栏里是 id。
 *
 * ★ 2026-09-30 起分了两层：
 *   · **`/` 是落地页**（门面，访客先看到它）；
 *   · **App 住在 `/app` 底下**。
 *   已经登录的人打开 `/` 会被送去 `/app`（见 App.tsx 里那个 replace 跳转）——
 *   营销页是给访客看的，自己人每次打开都撞上它是打扰。
 *
 * ⚠️ App 底下**不止一屏**（2026-10-01 更正：这里原来写的是「修图 / 作品 / 详情」，
 *   那是一级导航只有两支时的口径）：一级导航是**三支**（修图 / 对话 / 作品，§6.1），
 *   另外还有用户管理（👤）和它底下的模型设置两屏 —— 全在这一份联合类型里，
 *   改导航之前先看下面 `View` 自己列的注释。
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
  // ★ 2026-10-04：**调色（微调）单列成一支**。用户原话：「那个微调照片的放在
  //   导航栏单列出来」（他叫的还是 09-30 之前的旧名字「微调」，见《文案规范》）。
  //   在那之前它是顶栏里的一颗开关按钮，和「下载 / 保存 / 新的一张」挤在一排 ——
  //   那三颗是**把图拿走**，它却是**改这张图**，本来就不是一类东西。
  //   ⚠️ 它是「修图」的**兄弟，不是它的子页面**：同一张照片、同一个舞台，
  //      但**右边那一区换人了** —— 修图页是对话区（说话改），它是微调区
  //      （拖那八条滑块）。用户 2026-10-04 的原话：「调色就是对图片微调的
  //      界面区不是对话区」—— 所以调色那一屏**不渲染对话栏**（见 App.tsx）。
  //      做了这一支才拿得到自己的网址，而左栏导航里每一支都得是个"地方"
  //      （亮的只有一个），一个开关做不到这件事。
  | { kind: 'adjust' }
  // 会话列表（§6.1，Task 6）。它是「对话」那一支：**过程**的家
  // —— 「修图」是现在这一次，「作品」是结果，三样是三件事，别合并（§3 第 3 条）。
  | { kind: 'sessions' }
  | { kind: 'gallery' }
  | { kind: 'work'; id: number }
  // 用户管理（§3.6）。收在右上角那颗 👤 后面（§3.2）—— 一辈子点几次，不占一级导航
  | { kind: 'account' }
  // 模型设置（§7.4）。**挂在用户管理底下**：从那一页的「模型」那一行进去，
  // 和 §3.6 那张图长的一样 —— 它不是一级导航，是设置里的一格。
  | { kind: 'models' }

/** App 的地盘。写在这儿是为了让"它挪过窝"这件事只有一处要说。 */
const APP = '/app'

/**
 * ★ 2026-10-03：**自己人也回得去门面**（左栏最底下那颗「产品介绍」走的就是它）。
 *
 * 它和落地页是**同一页**，只多带一个 `?home=1` —— App 里那条"登录着的人打开
 * `/` 就送去 `/app`"认这个参数，认出来就**不撵人**。
 *
 * ⚠️ 为什么是**网址参数**、不是内存里一个开关：得扛得住 F5。看完门面顺手
 * 刷新一下就被踢回 App，是这套里最容易踩的一脚 —— 参数跟着地址栏走，
 * 刷新、收藏、开新标签、发给别人（对方多半是访客，本来就看得到这一页）
 * 都不会变味。
 *
 * ⚠️ **`/` 仍然是这一页的正身**（`pathOf` 给的就是它）：直接输网址、发出去的
 * 链接走的都是它。这个参数只说一件事 —— "这一趟是**特意**来的"。
 */
export const FRONT_PAGE = '/?home=1'

/** 这一趟是不是**特意**来看门面的（`search` 直接给 `location.search`）。 */
export function askedForFrontPage(search: string): boolean {
  return new URLSearchParams(search).get('home') === '1'
}

export function viewFromPath(path: string): View {
  // 详情页：新老两种形态都认
  const m = /^\/works\/(\d+)$/.exec(path) ?? /^\/app\/works\/(\d+)$/.exec(path)
  if (m) return { kind: 'work', id: Number(m[1]) }
  if (path === '/works' || path === `${APP}/works`) return { kind: 'gallery' }
  // 会话列表和上面几个一样要**认得出来**（F5、收藏、别人发来的一条链接）——
  // 少认这一行，按 F5 的人会被扔去修图页，而他明明还站在列表上。
  if (path === `${APP}/sessions`) return { kind: 'sessions' }
  if (path === `${APP}/account`) return { kind: 'account' }
  // 模型设置也可以直接打开（F5、收藏、别人发来的一条链接）——
  // 少认这一行，用户按 F5 就被扔回修图页，而他明明还在这页上。
  if (path === `${APP}/models`) return { kind: 'models' }
  // 调色（★ 2026-10-04）—— 和上面几个一样要**认得出来**（F5、收藏、别人发来的
  // 一条链接）。少认这一行，按 F5 的人会被扔回修图页，而他明明正开着调色面板。
  if (path === `${APP}/adjust`) return { kind: 'adjust' }
  if (path === APP) return { kind: 'edit' }
  if (path === '/') return { kind: 'landing' }
  return { kind: 'landing' }
}

export function pathOf(v: View): string {
  if (v.kind === 'landing') return '/'
  if (v.kind === 'sessions') return `${APP}/sessions`
  if (v.kind === 'gallery') return `${APP}/works`
  if (v.kind === 'work') return `${APP}/works/${v.id}`
  if (v.kind === 'account') return `${APP}/account`
  if (v.kind === 'models') return `${APP}/models`
  if (v.kind === 'adjust') return `${APP}/adjust`
  return APP
}
