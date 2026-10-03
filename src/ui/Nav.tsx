import type { View } from './view'

/**
 * 左栏。**详情页时「作品」也是亮的** —— 详情页属于作品那一支，不是第三个地方。
 *
 * ★ 2026-10-01（Task 6，§6.1）：三支 = **修图 / 对话 / 作品**，顺序就是这个
 * —— 修图是主入口，作品在最后。三样是三件事：现在是「修图」（这次在改的照片）、
 * 「对话」是过程（改过哪些），「作品」是结果。别合并。
 */
export function Nav({ view, onGo }: { view: View; onGo: (v: View) => void }) {
  const here = view.kind === 'work' ? 'gallery' : view.kind
  return (
    <nav className="nav">
      <button className={`nav-item${here === 'edit' ? ' on' : ''}`}
              onClick={() => onGo({ kind: 'edit' })}>修图</button>
      <button className={`nav-item${here === 'sessions' ? ' on' : ''}`}
              onClick={() => onGo({ kind: 'sessions' })}>对话</button>
      <button className={`nav-item${here === 'gallery' ? ' on' : ''}`}
              onClick={() => onGo({ kind: 'gallery' })}>作品</button>
      {/* ★ 2026-10-03：**回门面**（用户要的："能从操作页回到落地页"）。
          上一版里这件事**做不到** —— `/` 是落地页，而登录着的人一打开 `/` 就被
          送去 `/app`（见 App.tsx 那条自动跳转），自己人被关在 App 里出不去。

          ⚠️ 它**不是第四支导航**：上面那三支是 App 里的三个地方，这一颗是
          **出门**（去门面）。所以它钉在最底下、和上面隔着一整片空白
          （`.nav-home` 那条规则），别顺手挪到三支中间去。
          走的是 `ui/view.ts` 的 `FRONT_PAGE`（`/?home=1`）—— 那个参数就是
          "这一趟是特意来的"，自动跳转认得出它。 */}
      <button className="nav-item nav-home"
              onClick={() => onGo({ kind: 'landing' })}>首页</button>
    </nav>
  )
}
