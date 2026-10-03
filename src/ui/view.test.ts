import { describe, it, expect } from 'vitest'
import { FRONT_PAGE, askedForFrontPage, viewFromPath, pathOf } from './view'

/**
 * ⚠️ 2026-09-30 起分了两层：**`/` 是落地页**（门面），**App 住在 `/app` 底下**。
 * 这一份守的不只是"认得出几条路径"，还有一条很容易被当成小事的：
 * **老网址（`/works`、`/works/7`）必须照旧认** —— 用户手里可能有旧书签。
 */
describe('网址 ↔ 界面', () => {
  it('门口是落地页，App 在 /app 底下', () => {
    expect(viewFromPath('/')).toEqual({ kind: 'landing' })
    expect(viewFromPath('/app')).toEqual({ kind: 'edit' })
    expect(viewFromPath('/app/works')).toEqual({ kind: 'gallery' })
    expect(viewFromPath('/app/works/12')).toEqual({ kind: 'work', id: 12 })
  })

  it('★ 老的 App 网址照旧认 —— 分家之前发出去的链接不能白屏', () => {
    // 分家那天 `/` 从修图页变成了落地页，而 `/works`、`/works/7` 这一套
    // 是**分家之前的形态**。用户的书签、发给自己的链接都长这样。
    // 它们只是"认得出来"：真走过去之后 `go()` 会把地址改写成 `/app/...` 那一套。
    expect(viewFromPath('/works')).toEqual({ kind: 'gallery' })
    expect(viewFromPath('/works/7')).toEqual({ kind: 'work', id: 7 })
  })

  it('★ 认不出来的路径退回落地页 —— 不是白屏、也不是报错', () => {
    // 用户可能手打一个错地址、或者跟了一个坏链接。首页是那种情况下的标准答案。
    // ⚠️ 这条**2026-09-30 改过方向**：原来是"退回修图页"。改的理由是有了落地页
    // ——它才是 `/`，而"认不出来 → 回首页"是所有人都懂的那条规矩。
    // 顺带它把另一半也接住了：**登录着的人不会因此被关在营销页上**，
    // 落地页那一条会立刻把他们送去 `/app`（见 App.tsx 里那个 replace 跳转）。
    for (const p of ['/nope', '/works/abc', '/works/12/x', '/works/', '/app/nope']) {
      expect(viewFromPath(p).kind).not.toBe('work')
      expect(viewFromPath(p).kind).not.toBe('gallery')
    }
    expect(viewFromPath('/nope')).toEqual({ kind: 'landing' })
  })

  it('★ 用户管理 / 模型设置也能**直接打开**（F5、收藏、别人发来的链接）', () => {
    // 这两页都收在右上角那颗 👤 后面（§3.2 / §3.6 / §7.4），但地址栏里的路径照样
    // 是能直接打开的：`viewFromPath` 少认一行，按 F5 的人就被扔回修图页了 ——
    // 而他明明还在这一页上（那种"刷新一下回到别处"最让人以为是自己点错了）。
    expect(viewFromPath('/app/account')).toEqual({ kind: 'account' })
    expect(viewFromPath('/app/models')).toEqual({ kind: 'models' })
    expect(pathOf({ kind: 'account' })).toBe('/app/account')
    expect(pathOf({ kind: 'models' })).toBe('/app/models')
  })

  it('来回一趟是原样 —— 不然前进/后退会越走越偏', () => {
    // ⚠️ 这个清单**必须是全的**：`View` 的每一支都要在这里出现一次。
    //   「对话」（`sessions`）原来漏在清单外 —— 于是新那条路由**一个单测都没有**，
    //   而它是按 F5 / 收藏 / 转发链接时的落点（2026-10-01 终审补的）。
    for (const v of [
      { kind: 'landing' } as const,
      { kind: 'edit' } as const,
      { kind: 'sessions' } as const,
      { kind: 'gallery' } as const,
      { kind: 'work', id: 7 } as const,
      { kind: 'account' } as const,
      { kind: 'models' } as const,
    ]) {
      expect(viewFromPath(pathOf(v))).toEqual(v)
    }
  })

  it('★ 「对话」的网址认得出来、也拼得回去', () => {
    // 少认这一行，按 F5 的人会被扔回修图页 —— 而他明明还站在会话列表上
    // （那种"刷新一下回到别处"最让人以为是自己点错了）。见的另一头在 Nav.tsx。
    expect(viewFromPath('/app/sessions')).toEqual({ kind: 'sessions' })
    expect(pathOf({ kind: 'sessions' })).toBe('/app/sessions')
  })

  it('★ 作品详情页的网址里**没有名字**，只有 id（§3.5.1）', () => {
    expect(pathOf({ kind: 'work', id: 7 })).toBe('/app/works/7')
  })

  it('★ 门面另外有一个「特意来看」的网址 —— 左栏那颗「首页」走它（2026-10-03）', () => {
    // 登录着的人一打开 `/` 就会被送去 `/app`（App.tsx 里那条），所以从 App 里
    // **主动**回门面得走一条能表明"这一趟是特意来的"的网址。它和 `/` 是同一页。
    //
    // ⚠️ 这两条要**一起**守：① 它指的确实是落地页那一支；② `askedForFrontPage`
    //    认得的就是 `FRONT_PAGE` 自己带的那个参数。只守 ① 的话，把参数名从
    //    `home` 改成别的，两处会**各自安静地**错开 —— 那颗按钮当场变回"点了没反应"。
    expect(new URL(FRONT_PAGE, 'http://x').pathname).toBe('/')
    expect(askedForFrontPage(new URL(FRONT_PAGE, 'http://x').search)).toBe(true)
    // 正身仍然是 `/`：直接输网址、发出去的链接走的都是它（`go()` 那一侧才用 FRONT_PAGE）
    expect(pathOf({ kind: 'landing' })).toBe('/')

    expect(askedForFrontPage('')).toBe(false)
    expect(askedForFrontPage('?home=0')).toBe(false)
    expect(askedForFrontPage('?x=1')).toBe(false)
  })
})
