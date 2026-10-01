import { HttpError } from './http.ts'

/**
 * 把 `data:image/jpeg;base64,…` 解成字节 + 扩展名。
 *
 * ⚠️ 这个仓库里**第一次**有人真的去解一个 data URL —— 三个 AI 接口只校验前缀就把整串
 * 转给上游了。所以这里的每一个边界都得自己守：只收 jpeg / png（导出就这两种），
 * 正则直接把"带别的东西的串"挡在外面，`Buffer.from(…, 'base64')` 对垃圾输入**不抛**
 * （`server/password.ts:66` 记过这一条），所以**不能靠 try/catch 兜底**，
 * 只能靠前面的正则先把形状卡死。
 *
 * ⚠️ 2026-10-01 从 `works.ts` 搬到这里 —— 会话那边要用一模一样的一套。
 * 搬的时候**一个字没改**：两边各写一份的话，哪天补了第三种图片格式，
 * 只改一边就是"作品能存、会话存不进"这种半截坏。
 */
export function decodeDataUrl(s: string): { bytes: Uint8Array; ext: string } {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s)
  if (!m) throw new HttpError('BAD_REQUEST', '图得是 data:image/jpeg 或 data:image/png 的 base64', 400)
  return {
    bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')),
    ext: m[1] === 'png' ? '.png' : '.jpg',
  }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png' }

/** 从文件名尾巴推 MIME。认不出来就按 jpeg —— 存进去的只可能是这两种 */
export function mimeOf(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.'))] ?? 'image/jpeg'
}
