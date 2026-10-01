import { get, post, put, del } from './client'
import type { SessionDetail, SessionMeta, SessionMessage, SessionStep } from '../../shared/sessions.ts'

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
  title?: string | null
}
export async function updateSession(id: number, patch: SessionPatch): Promise<SessionMeta> {
  return put<SessionMeta>(`/api/sessions/${id}`, patch)
}
export async function deleteSession(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/sessions/${id}`)
}

/**
 * ⚠️ `v` 是**缓存钥匙**。`updated_at` 每改一次就变，所以缩略图的 URL 跟着变 ——
 * 不变的话浏览器会一直拿 `immutable` 缓存里那张旧缩略图（和作品那边
 * `fileUrl` 的第二段注释是同一条规矩）。
 */
export const sessionOriginalUrl = (id: number): string => `/api/sessions/${id}/file/original`
export const sessionBaseUrl = (id: number, v = 0): string => `/api/sessions/${id}/file/base?v=${v}`
export const sessionStepUrl = (id: number, stepId: number): string => `/api/sessions/${id}/file/step/${stepId}`
export const sessionThumbUrl = (id: number, v = 0): string => `/api/sessions/${id}/thumb?v=${v}`
