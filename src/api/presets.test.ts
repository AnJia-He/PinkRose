import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreset, deletePreset, listPresets, renamePreset } from './presets.ts'
import { ZERO } from '../../shared/adjustments.ts'

/**
 * 「我的预设」四个动词打出去的样子（★ 2026-10-10）。
 *
 * 钉的是**方法和 URL**、以及请求体的字段名：服务端那两条路由是精确匹配的，
 * 路径或动词写错在这里不会报错 —— 真跑到就是 404，界面上表现为"点了没反应"。
 * 请求体同理：服务端只认 `name` / `params` 这两个键（`readName` /
 * `clampAdjustments`），换个字段名服务端就 400，而客户端编译得过。
 */
afterEach(() => vi.unstubAllGlobals())

const stubFetch = (body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body))

const META = { id: 3, name: '日落', params: ZERO, createdAt: 1_700_000_000_000 }

describe('listPresets', () => {
  it('GET /api/presets，把 presets 解出来', async () => {
    const calls = stubFetch({ presets: [META] })
    const { presets } = await listPresets()
    expect(calls[0]!.url).toBe('/api/presets')
    expect(calls[0]!.init.method).toBe('GET')
    expect(presets).toEqual([META])
  })
})

describe('createPreset', () => {
  it('POST /api/presets，体是 {name, params} —— 名字和整套参数一起送', async () => {
    const calls = stubFetch({ preset: META })
    const { preset } = await createPreset('日落', ZERO)
    expect(calls[0]!.url).toBe('/api/presets')
    expect(calls[0]!.init.method).toBe('POST')
    expect(sentBody(calls[0]!)).toEqual({ name: '日落', params: ZERO })
    expect(preset).toEqual(META)
  })
})

describe('renamePreset', () => {
  it('PATCH /api/presets/3，体是 {name} —— 只送名字，参数不动（服务端只 UPDATE name）', async () => {
    const calls = stubFetch({ preset: { ...META, name: '晚霞' } })
    const { preset } = await renamePreset(3, '晚霞')
    expect(calls[0]!.url).toBe('/api/presets/3')
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(sentBody(calls[0]!)).toEqual({ name: '晚霞' })
    expect(preset.name).toBe('晚霞')
  })
})

describe('deletePreset', () => {
  it('DELETE /api/presets/3，不带请求体', async () => {
    const calls = stubFetch({ ok: true })
    await expect(deletePreset(3)).resolves.toEqual({ ok: true })
    expect(calls[0]!.url).toBe('/api/presets/3')
    expect(calls[0]!.init.method).toBe('DELETE')
    // 服务端那条 DELETE 不读请求体 —— 没体就不该有 content-type 那套头
    // （`client.test.ts` 里那条是同一个判据）。
    expect(calls[0]!.init.body).toBeUndefined()
  })
})
