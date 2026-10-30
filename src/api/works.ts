import { get, post, patch, put, del } from './client'
import type { WorkMeta, WorkDetail, Recipe, SharedWork } from '../../shared/works.ts'
import type { WorkColor, WorkFlag } from '../../shared/works.ts'

/**
 * 作品集的接口。图**不从这里走** —— 它是 `<img src>` 让浏览器自己取的，
 * 所以 `fileUrl()` / `fullUrl()` 返回的是一段网址，不是一次请求。
 *
 * ⚠️ **两个网址函数，两种用途，别混**：`fileUrl` = 列表上那张小图（缩略图，≤480px），
 * `fullUrl` = 原图（详情页看大图 + 下载）。混用会把缩略图当成「大图」，
 * 详见各自的注释（C1）。
 */
export async function listWorks(albumId?: number): Promise<WorkMeta[]> {
  const path = albumId === undefined ? '/api/works' : `/api/works?album=${albumId}`
  return (await get<{ works: WorkMeta[] }>(path)).works
}

export async function getWork(id: number): Promise<WorkDetail> {
  return get<WorkDetail>(`/api/works/${id}`)
}

/** 开启 / 取回这张作品的公开分享 token（幂等）。 */
export async function createWorkShare(id: number): Promise<{ token: string }> {
  return post<{ token: string }>(`/api/works/${id}/share`, {})
}

/** 停止分享：旧链接立刻失效。 */
export async function revokeWorkShare(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/works/${id}/share`)
}

/** 公开分享页的元数据（不需要登录）。 */
export async function getSharedWork(token: string): Promise<SharedWork> {
  return get<SharedWork>(`/api/share/${encodeURIComponent(token)}`)
}

/**
 * 公开分享页的图片网址。`thumb` 是列表/预览用的小图；
 * 分享页的大图必须用 `image`（和详情页 `fullUrl` 同一条规矩）。
 */
export function sharedImageUrl(
  token: string, updatedAt: number, kind: 'image' | 'thumb' = 'image',
): string {
  return `/api/share/${encodeURIComponent(token)}/${kind}?v=${updatedAt}`
}

export type WorkInput = {
  image: string
  thumb?: string
  recipe?: Recipe
  /** 用户原文件名；服务端只保留基础文件名。 */
  sourceName?: string
  /** EXIF 拍摄时间（毫秒）；没有可信拍摄时间时不传。 */
  capturedAt?: number
  cameraMake?: string
  cameraModel?: string
  lensModel?: string
}

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

/** 0 = 清除评分，1~5 星。只改整理状态，不动图片和 `updated_at`。 */
export async function rateWork(id: number, rating: number): Promise<WorkMeta> {
  return patch<WorkMeta>(`/api/works/${id}`, { rating })
}

/** -1 = 排除，0 = 清除标记，1 = 保留。 */
export async function flagWork(id: number, flag: WorkFlag): Promise<WorkMeta> {
  return patch<WorkMeta>(`/api/works/${id}`, { flag })
}

/** 批量选片标记：一次往返写混合的保留 / 排除建议。 */
export async function flagWorks(
  items: { id: number; flag: WorkFlag }[],
): Promise<{ flagged: number[]; missing: number[] }> {
  return post<{ flagged: number[]; missing: number[] }>('/api/works/flag', { items })
}

/** 设置 / 清除颜色标签；只改整理状态，不动图片和 `updated_at`。 */
export async function colorWork(id: number, color: WorkColor): Promise<WorkMeta> {
  return patch<WorkMeta>(`/api/works/${id}`, { color })
}

/** 批量评分：一次往返；不在作品集里的 id 由服务端放进 `missing`。 */
export async function rateWorks(
  ids: number[], rating: number,
): Promise<{ rated: number[]; missing: number[] }> {
  return post<{ rated: number[]; missing: number[] }>('/api/works/rate', { ids, rating })
}

/** 批量颜色标签：一次往返；不在作品集里的 id 由服务端放进 `missing`。 */
export async function colorWorks(
  ids: number[], color: WorkColor,
): Promise<{ colored: number[]; missing: number[] }> {
  return post<{ colored: number[]; missing: number[] }>('/api/works/color', { ids, color })
}

export async function deleteWork(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/works/${id}`)
}

/**
 * 批量删。
 *
 * 作品页的多选批删走它（一个往返；服务端逐条删并如实回报）。
 * 同一档里的「下载」走 `fullUrl` 逐张取原图，再由 `batch/works` 打包，不走本接口。
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
 * 只取作品缩略图，供本地选片分析使用。
 *
 * 和 `fetchWorkImage` 的区别是：没有缩略图时直接失败，让调用方跳过这张，
 * 不悄悄退回原图。否则“找相似 / 挑最好只读缩略图”的承诺就会在旧作品上失效，
 * 一次分析也可能变成下载几十张原片。
 */
export async function fetchWorkThumb(w: WorkMeta): Promise<Blob> {
  if (!w.hasThumb) throw new Error('这张作品没有缩略图')
  const r = await fetch(`/api/works/${w.id}/thumb?v=${w.updatedAt}`)
  if (!r.ok) throw new Error(`取作品缩略图失败：${r.status}`)
  return r.blob()
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
 * 取作品的**原图字节**（★ 2026-10-19，相册整组批量处理用）。
 *
 * 和 `fetchWorkImage` 同一层，但走 `fullUrl`：批量处理要把整张照片重新编码，
 * 拿缩略图会把成片降级。单张失败由调用方逐条计数，不拖垮整组。
 */
export async function fetchWorkFullImage(w: WorkMeta): Promise<Blob> {
  const r = await fetch(fullUrl(w))
  if (!r.ok) throw new Error(`取作品原图失败：${r.status}`)
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
