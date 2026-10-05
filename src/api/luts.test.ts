import { afterEach, describe, expect, it, vi } from 'vitest'
import { lutFileText } from './luts.ts'
import { ApiError } from './client.ts'

/**
 * ★ 2026-10-05 终审修复：`lutFileText` 走的是裸 `fetch`（正文是文本，不能走 `get`），
 * 但**失败必须是 `ApiError`** —— 和 `client.ts` 那三个出口同一套形状。
 *
 * 为什么值得单独钉：它以前扔的是裸 `Error`（401 认不出来、网络层的 TypeError 原样
 * 逃出），而唯一的调用点把它吞成一行 `console.error` —— 于是"格子亮着、画面没变、
 * 一句话都不说"（见 `src/app/useLuts.ts` 那段注释）。
 */
afterEach(() => vi.unstubAllGlobals())

const stubFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return fn(url, init)
  })
  return calls
}

describe('lutFileText', () => {
  it('成功：回正文原文（不是 JSON 解出来的东西）', async () => {
    const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n'
    stubFetch(async () => new Response(CUBE, { status: 200 }))
    await expect(lutFileText(3)).resolves.toBe(CUBE)
  })

  it('带上 cookie —— 和 `client.ts` 同一条规矩（不带的话每个请求都像"没登录"）', async () => {
    const calls = stubFetch(async () => new Response('x', { status: 200 }))
    await lutFileText(3)
    expect(calls[0]!.url).toBe('/api/luts/3/file')
    expect(calls[0]!.init.credentials).toBe('same-origin')
  })

  it('401 → ApiError(UNAUTHORIZED)：调用方认得出"票不管用了"', async () => {
    stubFetch(async () => new Response('nope', { status: 401 }))
    const e = await lutFileText(3).catch(e => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('UNAUTHORIZED')
  })

  it('5xx → ApiError，带一句中文（不是裸 Error）', async () => {
    stubFetch(async () => new Response('boom', { status: 500 }))
    const e = await lutFileText(3).catch(e => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toContain('没取回来')
  })

  it('连不上（网络层 TypeError）也翻成 ApiError —— 调用方只需要认识一种错误类型', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    const e = await lutFileText(3).catch(e => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('UPSTREAM_FAILED')
  })
})
