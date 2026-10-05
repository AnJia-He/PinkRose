import { ApiError, del, get, patch, post } from './client'
import type { LutMeta } from '../../shared/lut.ts'

/**
 * 滤镜的接口（2026-10-05 设计）。这个文件是**这一层唯一知道网址的地方** ——
 * 组件不拼 URL（和 `api/works.ts` / `api/models.ts` 同一条规矩）。
 */

export const listLuts = () => get<{ luts: LutMeta[] }>('/api/luts')

/** 导入。`cube` 是 **.cube 的原文**（服务端要再解析一遍，别送 base64）。 */
export const createLut = (name: string, cube: string) =>
  post<{ lut: LutMeta }>('/api/luts', { name, cube })

/**
 * 取原文。⚠️ 用 `fetch` 而不是 `get`：`get` 会把正文当 JSON 解，而这里是文本。
 *
 * ★ 2026-10-05 终审修复：失败**照样是 `client.ts` 那一套 `ApiError`** —— 这儿原来
 *   扔的是裸 `Error`（401 认不出来、网络层的 `TypeError` 原样逃出），唯一的调用点
 *   只能把它吞成一行 console，用户看到的是"格子亮着、画面没变、一句话没有"。
 *
 * 只做三件事，**不复制 `client.ts` 整个 `request`**（正文是文本，那套 JSON 解析
 * 在这儿用不上）：非 2xx → `ApiError`；连不上 / 读正文半路断了（都是 `TypeError`）
 * → `ApiError`；认得出 401 就给它 `UNAUTHORIZED`（`isUnauthorized` 就是按这个码判的）。
 */
export async function lutFileText(id: number): Promise<string> {
  let res: Response
  try {
    // ⚠️ `credentials: 'same-origin'` 必须有 —— 不带的话浏览器不发那个 cookie，
    //    于是**每个**请求看上去都是"没登录"（`client.ts` 里那段注释同一条）。
    res = await fetch(`/api/luts/${id}/file`, { credentials: 'same-origin' })
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？')
  }
  if (!res.ok) {
    throw new ApiError(
      res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
      res.status === 401
        ? '登录状态过期了，刷新一下页面重新登录。'
        : `那个滤镜没取回来（服务器回了 ${res.status}）。`)
  }
  // 读正文是独立的一次往返（`fetch` 在响应头到达时就 resolve 了）——
  // 连接中途被掐断抛的是裸 `TypeError`，和上面"连不上"走同一条路。
  try {
    return await res.text()
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？')
  }
}

/** 删之前先问一句"有谁在用" —— 那句话的唯一依据。 */
export const lutUsage = (id: number) => get<{ sessions: number }>(`/api/luts/${id}/usage`)
export const renameLut = (id: number, name: string) => patch<{ lut: LutMeta }>(`/api/luts/${id}`, { name })
export const deleteLut = (id: number) => del<{ ok: true }>(`/api/luts/${id}`)
