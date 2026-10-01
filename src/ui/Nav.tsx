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
    </nav>
  )
}
