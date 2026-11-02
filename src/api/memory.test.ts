import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMemoryProfile, getMemoryProfile, setMemoryEnabled } from './memory'

function reply(memory: unknown): Response {
  return new Response(JSON.stringify({ memory }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('长期偏好客户端', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('读取、关闭和清除都走同一个账号接口', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ enabled: true, summary: '喜欢自然肤色', updatedAt: 1 }))
      .mockResolvedValueOnce(reply({ enabled: false, summary: '喜欢自然肤色', updatedAt: 2 }))
      .mockResolvedValueOnce(reply({ enabled: false, summary: null, updatedAt: 3 }))
    vi.stubGlobal('fetch', fetchMock)

    expect((await getMemoryProfile()).summary).toBe('喜欢自然肤色')
    expect((await setMemoryEnabled(false)).enabled).toBe(false)
    expect((await clearMemoryProfile()).summary).toBeNull()
    expect(fetchMock.mock.calls.map((c) => [c[0], c[1]?.method])).toEqual([
      ['/api/memory', 'GET'],
      ['/api/memory', 'PATCH'],
      ['/api/memory', 'DELETE'],
    ])
  })
})
