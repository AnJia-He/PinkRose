import { get, post, put, del } from './client'
import type { SessionDetail, SessionMeta, SessionMessage, SessionStep } from '../../shared/sessions.ts'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'

/**
 * 会话的接口。图**不从这里走** —— 和作品那套同一条规矩：图是 `<img src>`
 * 让浏览器自己取的，所以下面那几个 `*Url` 返回的是网址，不是一次请求。
 */
export async function listSessions(): Promise<SessionMeta[]> {
  return (await get<{ sessions: SessionMeta[] }>('/api/sessions')).sessions
}
export async function createSession(
  image: string, thumb?: string, name?: string,
): Promise<{ id: number }> {
  return post<{ id: number }>('/api/sessions', {
    image,
    ...(thumb ? { thumb } : {}),
    // 用户那张照片**上传时的名字**。spec §6.3 的列表标题和恢复后「下载」的文件名
    // 都靠它。空串当没给（服务端也这么收）。
    ...(name ? { name } : {}),
  })
}
export async function getSession(id: number): Promise<SessionDetail> {
  return get<SessionDetail>(`/api/sessions/${id}`)
}
export type SessionPatch = {
  /** **只在底图真的换了的时候传** —— 拖滑块那种更新不许带它（那会多存一个没人用的文件） */
  base?: string
  thumb?: string
  messages?: SessionMessage[]
  /** ⚠️ 送的是**完整的一串**，服务端拿它和库里已有的按 `id` 对齐 */
  steps?: Omit<SessionStep, 'reusesPrev'>[]
  /**
   * **现在这一版参数**。⚠️ 它不是可选的礼貌项 —— 见下面那段。
   *
   * ★ 为什么必须单独有一个字段：这个客户端里 **`params` 和 `history` 是两回事**。
   *   `App.tsx` 有一句明确的既有裁定：「**改 params 从来不 push 快照 —— 快照是给
   *   "生成式编辑"用的（裁定 ⑤）**」（见 `WorkDetailPage` 那个 `onApply` 的注释）。
   *   于是拖滑块、套预设、按重置，**都不会让 `history` 变**。
   *
   * ⚠️ 不传它的后果是**用户看得见**的：拖完滑块刷新一下，屏幕上回到拖之前的样子。
   *   而验收线第 1 条写着「上传 → 说一句话 → 刷新 → 照片、对话、**参数全在**」。
   */
  params?: Adjustments
  /**
   * **现在这一版的滤镜**（`{ lutId, amount }`，null = 没用滤镜）。
   *
   * ★ 2026-10-05（滤镜）：它和 `params` 是**同一条路、同一个理由** ——
   *   套滤镜 / 拖强度**都不推快照**（裁定 ⑤），所以不单独送它的话，
   *   用户选完滤镜刷新一下，那层颜色就没了（屏幕上什么都不说）。
   *   服务端把它写在**最后一步**上（`handleUpdateSession`），和 params 一样。
   */
  lut?: LutRef | null
  /**
   * 改标题。
   *
   * ⚠️ **`string`，不是 `string | null`** —— 这两个值在服务端是**两件事**
   * （`server/sessions.ts`）：`null` / 不传 = **"这次不动标题"**，而**清空要传 `''`**
   * （服务端把空串存成 `null` = 还没起名）。类型写成 `string | null` 的话，
   * 下一个实现"改名/清空"的人会照着类型传 `null` 想要清空 —— 而它什么都不做，
   * **一句报错都没有**，正是这个项目最恨的那种失败。
   */
  title?: string
}
/** ⚠️ `keepalive`：页面正在消失时（刷新 / 关标签页）那趟落盘要用它才发得出去
 *  —— 理由和 64 KiB 的体量上限都写在 `./client` 的 `send` 那段。 */
export async function updateSession(
  id: number, patch: SessionPatch, keepalive = false,
): Promise<SessionMeta> {
  return put<SessionMeta>(`/api/sessions/${id}`, patch, keepalive)
}
export async function deleteSession(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/sessions/${id}`)
}

/**
 * ⚠️ `v` 是**缓存钥匙**。`updated_at` 每改一次就变，所以缩略图的 URL 跟着变 ——
 * 不变的话浏览器会一直拿 `immutable` 缓存里那张旧缩略图（和作品那边
 * `fileUrl` 的第二段注释是同一条规矩）。
 *
 * ⚠️ **这里没有 `sessionBaseUrl`**（2026-10-01 终审删的）。原来有一个
 * `/api/sessions/:id/file/base` 的助手，**全仓零调用**，而 `sendBytes` 给
 * **每一条**图片路由都盖了 `immutable` 长缓存 —— 谁哪天顺手拿它当 `<img src>`
 * 而不带 `?v=`，拿到的就是一张**永远换不掉**的旧底图（服务端换了图，浏览器
 * 照旧拿缓存里那张，不报错）。下面这个函数是同一个坑的正确形状：**要带 `v`**。
 * 真要用底图那天，照 `sessionThumbUrl` 写一个**必带 `v`** 的版本，别恢复旧名字。
 */
export const sessionOriginalUrl = (id: number): string => `/api/sessions/${id}/file/original`
export const sessionStepUrl = (id: number, stepId: number): string => `/api/sessions/${id}/file/step/${stepId}`
export const sessionThumbUrl = (id: number, v = 0): string => `/api/sessions/${id}/thumb?v=${v}`
