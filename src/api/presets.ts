import { get, post, patch, del } from './client'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { PresetMeta } from '../../shared/preset.ts'

/**
 * 「我的预设」的接口（★ 2026-10-10）。和 `api/luts.ts` 同一条规矩：
 * 这个文件是**这一层唯一知道网址的地方** —— 组件不拼 URL。
 *
 * 四个动词和任务 1 的服务端一一对应（`GET/POST /api/presets`、
 * `PATCH/DELETE /api/presets/:id`）；改名/删除之后清单怎么维护不在这一层 ——
 * 调用方走 `usePresets` 的 `refresh`（重拉，别在本地改名单）。
 */

export async function listPresets(): Promise<{ presets: PresetMeta[] }> {
  return get<{ presets: PresetMeta[] }>('/api/presets')
}

/** 存一套：名字 + 整套 15 个参数一起送（服务端会过 `clampAdjustments`）。 */
export async function createPreset(name: string, params: Adjustments): Promise<{ preset: PresetMeta }> {
  return post<{ preset: PresetMeta }>('/api/presets', { name, params })
}

/** 改名：**只送名字** —— 参数在这条路上不经过（服务端只 UPDATE name 那列）。 */
export async function renamePreset(id: number, name: string): Promise<{ preset: PresetMeta }> {
  return patch<{ preset: PresetMeta }>(`/api/presets/${id}`, { name })
}

export async function deletePreset(id: number): Promise<{ ok: true }> {
  return del<{ ok: true }>(`/api/presets/${id}`)
}
