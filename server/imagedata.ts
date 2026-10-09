import { HttpError } from './http.ts'
import type { Storage } from './storage.ts'

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

/**
 * `data URL → 字节`，外加两个尺寸判断：**空的 / 超上限**。
 *
 * ★ 2026-10-09 收口：这一组在 `works.ts` / `sessions.ts` 里各写了两遍（共四处，
 *   连两句话都一字不差）。上限由调用方给 —— 作品和会话各自的常量
 *   （`MAX_WORK_BYTES` / `MAX_IMAGE_BYTES`），**别在这里定死**。
 *
 * ⚠️ 两句话都是**给用户看**的（前端把服务端的 message 原样显示）：
 *   "图是空的" 和 "这张图太大了，存不下" 各说一件事，别合并成一句。
 */
export function readImageDataUrl(raw: string, maxBytes: number): { bytes: Uint8Array; ext: string } {
  const image = decodeDataUrl(raw)
  if (image.bytes.byteLength === 0) throw new HttpError('BAD_REQUEST', '图是空的', 400)
  if (image.bytes.byteLength > maxBytes) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)
  }
  return image
}

/**
 * 存一张**可选**的缩略图：解码 → 过体积上限 → 落盘。坏了就当"这张没有缩略图"
 * （返回 `null`），**不抛**。
 *
 * ★ 2026-10-09 收口：这段在 `works.ts` / `sessions.ts` 里各抄了两份（共 4 处，
 *   连注释都是从同一段复制过去的）—— 而它长成这样是有原因的，见下。
 *
 * ⚠️ **解码和落盘必须在同一个 try 里**（裁定 ②）。缩略图坏的姿势有两种 ——
 *   形状不对（解不出来）和存不下去（盘满 / 权限）—— 两种都只是"这张没有缩略图"，
 *   不该让用户丢掉整张照片。落盘那一步放在 try 外面的话，它一抛，
 *   **刚写好的新图**就一个人留在盘上没人认领（记录连提都没提它）。
 *
 * ⚠️ 但也不能**静默**：盘满、或者前端一直在送坏缩略图，服务端没有第二个地方会说话。
 *
 * `what` 只进那句 console（'这张作品' / '这条会话'）。返回存盘后的文件名和字节数
 * —— 会话那边要把缩略图的字节算进 `bytes`（配额账），作品那边只要名字。
 */
export async function saveOptionalThumb(
  raw: string, storage: Storage, what: string,
): Promise<{ name: string; bytes: number } | null> {
  if (!raw) return null
  try {
    const thumb = decodeDataUrl(raw)
    // ★ 2026-10-02（安全审计）：缩略图也要**有自己的体积上限**。
    //   原来它只受总请求体 12 MB 管着 —— 一个请求能塞进来约 9 MB 的"缩略图"，
    //   而照片那张本身的上限是 8 MB，"每张最多 8 MB"那句话当场不成立。
    //   超了就走"这张没有缩略图"这条既有路径，**不拖垮整张图** —— 和裁定 ② 同一个道理。
    if (thumb.bytes.byteLength > MAX_THUMB_BYTES) {
      throw new Error(`缩略图 ${thumb.bytes.byteLength} 字节，超过上限`)
    }
    const name = await storage.save(thumb.bytes, thumb.ext)
    return { name, bytes: thumb.bytes.byteLength }
  } catch (e) {
    console.error(`缩略图用不了（解不开或者存不下），${what}没有缩略图：`, e)
    return null
  }
}
