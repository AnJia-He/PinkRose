import { useCallback, useEffect, useState } from 'react'
import { FRONT_PAGE, askedForFrontPage, pathOf, viewFromPath, type View } from '../ui/view'
import type { AccountUser } from '../api/account'

/**
 * 左栏导航 + 网址（★ 2026-10-08 从 `App.tsx` 搬出来，设计见
 * `docs/superpowers/specs/2026-09-24-...` 那条"不引路由库"的老决定）。
 *
 * **不引路由库**：零依赖是硬约束，而我们要的只有两条路径 + 一条带参数的
 * —— `history.pushState` 就够了。引一个路由库来管三条路径，是拿一个新依赖
 * 换 20 行代码。路径怎么认、怎么拼，规则**只有一份**（`ui/view.ts` 那个纯函数），
 * 不散在这里。
 */
export function useNav({ checking, user }: {
  /** 开机那一次"我是谁"问完了没有（没问完不许跳）。 */
  checking: boolean
  user: AccountUser | null
}) {
  /** 现在在哪一屏。**它是切界面唯一会动的东西** —— 别的 state 一个都不碰，
   *  于是"切导航不丢工作"是结构上的必然，不是"记得保存"（§3.2）。 */
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname))

  /**
   * 点导航：改状态，顺手把地址栏换成对应的那条。
   *
   *  这两条语句**谁先谁后无所谓**：`pushState` 不会触发 `popstate`（规范就这么定的），
   *  `setView` 也不碰历史栈 —— 先写地址只是读起来顺，别在这儿找讲究。
   *
   *  ⚠️ 必须写 `window.history`（不能省成 `history`）：App 那个组件里有一份**同名**的
   *  撤销历史 `const [history, setHistory] = useState<Snapshot[]>([])`，它把全局那个
   *  `history` 遮住了 —— 省掉 `window.` 是个**编译期**的错
   *  （`TS2339: Property 'pushState' does not exist on type 'Snapshot[]'`）。
   *  写全是为了让下一个人一眼看见"要的是浏览器那个 history"，而不是先去读一遍
   *  类型错误才知道。
   *
   *  ⚠️ `replace`：**不往历史栈里压新条目**，只把当前这条换掉。
   *  只有一处用它 —— 登录着的人打开落地页时那个自动跳转。用 push 的话历史栈里
   *  会留下一条 `/`，用户按后退 → 又跳回来 → **按几次都出不去**。
   */
  const go = useCallback((v: View, opts?: { replace?: boolean }) => {
    // ★ 去**门面**那一页时走 `FRONT_PAGE`（= `/?home=1`），不是 `pathOf` 给的
    //  `/`（2026-10-03）。差别只在"谁走过去"：`/` 是这一页的正身（直接输网址、
    //  发链接都走它），而**从 App 里主动走过去**得带上那个参数 —— 不带的话
    //  下面那条自动跳转立刻把人送回 `/app`，点「产品介绍」像是没反应。
    //  ⚠️ 判断要写在**这一处**（写网址只有这一处），别在 Nav 里另开一条 pushState
    //   —— 那样"哪一屏对应哪个网址"就有了两份，迟早对不上。
    const p = v.kind === 'landing' ? FRONT_PAGE : pathOf(v)
    // ⚠️ "是不是已经在这一页上了"比的是 **`pathOf`**（不带参数的那个网址），
    // 不是上面那个 `p`：站在 `/?home=1` 上再点一次「产品介绍」，地址栏已经是它了，
    // 不该再压一条 —— 压了的话后退要按好几下才出得去。
    if (location.pathname !== pathOf(v)) {
      if (opts?.replace) window.history.replaceState(null, '', p)
      else window.history.pushState(null, '', p)
    }
    setView(v)
  }, [])

  // 浏览器的后退 / 前进：跟着地址走
  useEffect(() => {
    const onPop = () => setView(viewFromPath(location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /**
   * 已经登录的人打开 `/`（落地页）→ **直接送去 App**。
   *
   * ⚠️ 用 `replace`，不能 push：营销页是给访客看的，自己人每次打开都撞上它是
   * 打扰；而 push 会在历史栈里留下一条 `/`，用户一按后退又跳回来 —— 出不去。
   *
   * ⚠️ 它**只认自己人**：没登录的访客停在落地页上（那正是这一页存在的意义）。
   * `checking` 那一段要等 —— 还没问出"我是谁"就跳，会把每个登录着的人
   * 先闪一下落地页再走。
   *
   * ★ 2026-10-03：**特意来的不算**（`?home=1`，见 `ui/view.ts` 的 `FRONT_PAGE`）。
   * 左栏底下那颗「产品介绍」把人送到 `/?home=1`，这一条认出来就得让路 —— 不让的话
   * 那颗按钮会"点了没反应"（推过去、立刻被撵回来），而且地址栏还会被改回 `/app`。
   * 它守的仍然是原来那句话：**回访**的人不必每次打开都撞上营销页。
   *
   * ⚠️ 判据读的是 **`location.search`**，不是 `view` 上挂一个字段：按后退/前进
   * 回来时 `view` 是 `viewFromPath(pathname)` 拼的（它看不见 `?` 后面那截），
   * 挂在 view 上的话，从门面点「免费开始」进 App 再按后退 —— 人会被撵回来。
   */
  useEffect(() => {
    if (!checking && user && view.kind === 'landing' && !askedForFrontPage(location.search))
      go({ kind: 'edit' }, { replace: true })
  }, [checking, user, view, go])

  /**
   * 标签页那个标题。★ 2026-10-01 加的。
   *
   * `index.html` 里写死的标题是**落地页**那句（「说句话，照片就修好了」），
   * 而且必须写死在文件里 —— 社交抓取器和 AI 爬虫都不跑 JS，靠 JS 注入的标题
   * 它们一个字都读不到。代价是**每一屏一进来都顶着那句营销文案**，所以
   * App 这几屏要把它换回产品名。
   *
   * 落地页那一支不管：它自己的 effect 会设成同一句、离开时还原
   * （`LandingPage.tsx` 里那个 prevTitle）。
   */
  useEffect(() => {
    if (view.kind !== 'landing') document.title = 'PinkRose'
  }, [view.kind])

  return { view, go }
}
