import { HttpError } from './http.ts'

/**
 * 缩略图的体积上限（字节）。
 *
 * ★ 2026-10-02 加（安全审计）。在那之前缩略图**只受总请求体 12 MB 的限制** ——
 *   于是一个请求能塞进来约 9 MB 的"缩略图"，而作品那张本身的上限是 8 MB
 *   （`works.ts` 的 `MAX_WORK_BYTES`）。"每张作品最多 8 MB"那句话当场就不成立。
 *   1 MB 对一张 480 长边的 JPEG 是天文数字（正常十几 KB），拦得住滥用、
 *   碰不到正常。
 */
export const MAX_THUMB_BYTES = 1024 * 1024

/** JPEG 以 `FF D8 FF` 开头；PNG 是那八个固定字节。 */
const MAGIC = {
  '.jpg': [0xff, 0xd8, 0xff],
  '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
} as const

/** 只认文件头 —— 刻意**不去解码**：这一层不该认识图像格式，认识就得引一个库。 */
function looksLike(bytes: Uint8Array, ext: keyof typeof MAGIC): boolean {
  const sig = MAGIC[ext]
  if (bytes.length < sig.length) return false
  return sig.every((b, i) => bytes[i] === b)
}

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
 *
 * ★ 2026-10-02 补**魔数**校验（安全审计）：上面那道正则管的是"**声明**是 jpeg/png"，
 *   管不了"**内容**是不是"。所以 `data:image/png;base64,<HTML>` 会被原样落盘成
 *   `.png`、回读时还带着 `content-type: image/png`。今天的危害有限（服务端不解码
 *   图片），但**哪天谁给图片加一步服务端解码/转码，这里立刻变成实洞**；
 *   而且"盘上的东西和它的扩展名对不上"本身就是迟早要还的债。
 */
export function decodeDataUrl(s: string): { bytes: Uint8Array; ext: string } {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s)
  if (!m) throw new HttpError('BAD_REQUEST', '图得是 data:image/jpeg 或 data:image/png 的 base64', 400)
  const ext = m[1] === 'png' ? '.png' : '.jpg'
  const bytes = new Uint8Array(Buffer.from(m[2]!, 'base64'))
  if (!looksLike(bytes, ext)) {
    throw new HttpError('BAD_REQUEST', `这串不像是真的 ${m[1]}（内容和后缀对不上），换一张试试`, 400)
  }
  return { bytes, ext }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png' }

/** 从文件名尾巴推 MIME。认不出来就按 jpeg —— 存进去的只可能是这两种 */
export function mimeOf(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.'))] ?? 'image/jpeg'
}
