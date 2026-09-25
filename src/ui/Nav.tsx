import type { View } from './view'

/** 左栏。**详情页时「作品」也是亮的** —— 详情页属于作品那一支，不是第三个地方。 */
export function Nav({ view, onGo }: { view: View; onGo: (v: View) => void }) {
  const here = view.kind === 'work' ? 'gallery' : view.kind
  return (
    <nav className="nav">
      <button className={`nav-item${here === 'edit' ? ' on' : ''}`}
              onClick={() => onGo({ kind: 'edit' })}>修图</button>
      <button className={`nav-item${here === 'gallery' ? ' on' : ''}`}
              onClick={() => onGo({ kind: 'gallery' })}>作品</button>
    </nav>
  )
}
