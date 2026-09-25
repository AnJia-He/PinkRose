/**
 * 界面 ↔ 网址的对应关系。**规则只有这一份。**
 *
 * ⚠️ 详情页的网址里用 **id** 不用名字（§3.5.1）：名字能改，改完链接就失效；
 * 中文名还会被转义成一长串 `%E4%B8%AD%...`。页面上显示的**仍然是名字**，
 * 只是地址栏里是 id。
 *
 * 认不出来的路径**退回修图页** —— 用户可能手打错地址、或者用了一个旧书签，
 * 白屏是最差的答案。
 */
export type View =
  | { kind: 'edit' }
  | { kind: 'gallery' }
  | { kind: 'work'; id: number }

export function viewFromPath(path: string): View {
  const m = /^\/works\/(\d+)$/.exec(path)
  if (m) return { kind: 'work', id: Number(m[1]) }
  if (path === '/works') return { kind: 'gallery' }
  return { kind: 'edit' }
}

export function pathOf(v: View): string {
  if (v.kind === 'gallery') return '/works'
  if (v.kind === 'work') return `/works/${v.id}`
  return '/'
}
