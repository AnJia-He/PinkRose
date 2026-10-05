import { del, get, patch, post } from './client'
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
 * 失败照样要说人话 —— 走和 `client.ts` 同一套错误形状。
 */
export async function lutFileText(id: number): Promise<string> {
  const res = await fetch(`/api/luts/${id}/file`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`滤镜文件取不回来（${res.status}）`)
  return res.text()
}

/** 删之前先问一句"有谁在用" —— 那句话的唯一依据。 */
export const lutUsage = (id: number) => get<{ sessions: number }>(`/api/luts/${id}/usage`)
export const renameLut = (id: number, name: string) => patch<{ lut: LutMeta }>(`/api/luts/${id}`, { name })
export const deleteLut = (id: number) => del<{ ok: true }>(`/api/luts/${id}`)
