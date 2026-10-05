import { get, post, patch, put, del } from './client'
import type { WorkMeta, WorkDetail, Recipe } from '../../shared/works.ts'

/**
 * 作品集的接口。图**不从这里走** —— 它是 `<img src>` 让浏览器自己取的，
 * 所以 `fileUrl()` / `fullUrl()` 返回的是一段网址，不是一次请求。
 *
 * ⚠️ **两个网址函数，两种用途，别混**：`fileUrl` = 列表上那张小图（缩略图，≤480px），
 * `fullUrl` = 原图（详情页看大图 + 下载）。混用会把缩略图当成「大图」，
 * 详见各自的注释（C1）。
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

/**
 * 批量删。
 *
 * ⚠️ **这个接口今天没有任何界面在用（全仓零调用方）。** §3.5 的
 * 「多选之后 → [下载选中的 12 张] / [删除选中的 12 张]」那一整块**界面没做**：
 * 后端（`handleDeleteWorks`）和这条函数都齐活、测试也全，缺的是**多选**。
 * 它已经明确写进计划的「不在这一段里（后面几段的事，别顺手做）」表 ——
 * 别看到这个函数就以为界面上已经接上了。
 */
export async function deleteWorks(ids: number[]): Promise<{ deleted: number[]; missing: number[] }> {
  return post<{ deleted: number[]; missing: number[] }>('/api/works/delete', { ids })
}

/**
 * 小图的网址。**只给"要小图"的地方用** —— 今天两个：作品页的 `.gallery-thumb`，
 * 和调色面板「照着这张调」的参考图选择器（★ 2026-10-05；那里采样前反正要缩到
 * 96px，要的正是小图，所以它取字节也走这条网址，见下面的 `fetchWorkImage`）。
 *
 * 有缩略图就用缩略图（那正是缩略图存在的理由：一次摆 60 张，全取原图是几十 MB）；
 * 没有才退回原图 —— 缩略图是前端生成时顺手带的，可能没生成成功。
 *
 * ⚠️ **详情页绝不能用它。** 这里回的是缩略图（2026-09-25 起是 ≤480px 的
 * `GALLERY_THUMB_MAX_SIDE`；更早存进库的作品还是 160px 那一版），
 * 而详情页要的是"点开一张 → 看大图 / 下载到我的电脑"。这两件事的期望正好是
 * **相反**的 —— 详情页请用 `fullUrl`。合成一个函数的后果实测过：详情页那张
 * "大图"是缩略图，「下载到我的电脑」下到的也是它，而 §3.4 拿掉"保存自动
 * 下载"之后，那个按钮是用户把原图拿出服务器的**唯一**一条路。
 *
 * ⚠️ `?v=<updatedAt>` **不能去掉**：替换过一张之后 id 没变，
 * 而接口回的是长缓存（`immutable`）—— 没有版本号的话浏览器会给**上一版**。
 */
export function fileUrl(w: WorkMeta): string {
  return `/api/works/${w.id}/${w.hasThumb ? 'thumb' : 'file'}?v=${w.updatedAt}`
}

/**
 * 作品的**图字节**（★ 2026-10-05）。调色面板「照着这张调」从作品里挑参考图时用。
 *
 * 走 `fileUrl`（小图）不奇怪：那张图接下来会被缩到 96px 采样，**要的正是小图** ——
 * 拿原图只是白费流量。"要小图"这个判据和 `fileUrl` 注释里那条是同一条。
 *
 * ⚠️ 失败的抛出交给调用方（App 的 `matchWork`）翻成人话 —— 这一层不认识
 * 用户界面上的说法，`api/` 里别的函数也是这个分工。
 */
export async function fetchWorkImage(w: WorkMeta): Promise<Blob> {
  const r = await fetch(fileUrl(w))
  if (!r.ok) throw new Error(`取作品图失败：${r.status}`)
  return r.blob()
}

/**
 * 这张作品的**原图**网址。**详情页专用**（`.detail-image` 和 `.detail-download`）。
 *
 * ⚠️ **名字里的 `full` 是全部的意思，别看错成 `fileUrl`。** 一条 URL 只服务一种
 * 用途：`fileUrl` = 列表上那张小图（省流量），`fullUrl` = "我要的就是这张图本身"
 * （看大图、下载原件）。语义写在名字里，误用就写不出来 —— 这正是 C1 的形状。
 *
 * 详情页要看大图、要下载，**两处都必须是它**。
 */
export function fullUrl(w: WorkMeta): string {
  return `/api/works/${w.id}/file?v=${w.updatedAt}`
}
