import { get, post, patch, put, del } from './client'
import type { WorkMeta, WorkDetail, Recipe } from '../../shared/works.ts'

/**
 * 作品集的接口。图**不从这里走** —— 它是 `<img src>` 让浏览器自己取的，
 * 所以 `fileUrl()` 返回的是一段网址，不是一次请求。
 */
export async function listWorks(): Promise<WorkMeta[]> {
  return (await get<{ works: WorkMeta[] }>('/api/works')).works
}

export async function getWork(id: number): Promise<WorkDetail> {
  return get<WorkDetail>(`/api/works/${id}`)
}

export type WorkInput = { image: string; thumb?: string; recipe?: Recipe }

export async function createWork(o: WorkInput): Promise<{ id: number }> {
  return post<{ id: number }>('/api/works', o)
}

export async function replaceWork(id: number, o: WorkInput): Promise<WorkMeta> {
  return put<WorkMeta>(`/api/works/${id}`, o)
}

/** `alias` 传 null = 改回"用时间当名字"（那是个有意义的状态，不是缺数据） */
export async function renameWork(id: number, alias: string | null): Promise<WorkMeta> {
  return patch<WorkMeta>(`/api/works/${id}`, { alias })
}

export async function deleteWork(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/works/${id}`)
}

export async function deleteWorks(ids: number[]): Promise<{ deleted: number[]; missing: number[] }> {
  return post<{ deleted: number[]; missing: number[] }>('/api/works/delete', { ids })
}

/**
 * 这张图的网址。给 `<img src>` 用。
 *
 * ⚠️ `?v=<updatedAt>` **不能去掉**：替换过一张之后 id 没变，
 * 而接口回的是长缓存（`immutable`）—— 没有版本号的话浏览器会给**上一版**。
 */
export function fileUrl(w: WorkMeta): string {
  return `/api/works/${w.id}/${w.hasThumb ? 'thumb' : 'file'}?v=${w.updatedAt}`
}
