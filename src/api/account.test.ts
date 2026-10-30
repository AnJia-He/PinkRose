// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signup, login, logout, me, savePreferences } from './account'

const calls: { url: string; init: RequestInit | undefined }[] = []
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify({ user: { id: 1, username: 'a', email: 'a@b.com' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('账号接口', () => {
  it('★ 每个请求都带 credentials —— 不带的话 cookie 根本不会发', () => {
    return login({ username: 'a', password: 'password123' }).then(() => {
      expect(calls[0]!.init?.credentials).toBe('same-origin')
    })
  })

  it('打的是对的地址', async () => {
    await signup({ username: 'a', email: 'a@b.com', password: 'password123' })
    expect(calls[0]!.url).toBe('/api/signup')
    calls.length = 0
    await login({ username: 'a', password: 'password123' })
    expect(calls[0]!.url).toBe('/api/login')
    calls.length = 0
    await logout()
    expect(calls[0]!.url).toBe('/api/logout')
  })

  it('me() 是 GET', async () => {
    await me()
    expect(calls[0]!.init?.method).toBe('GET')
  })

  it('savePreferences 走 PATCH /api/me，并把偏好放在 preferences 里', async () => {
    const user = await savePreferences({ export: { format: 'image/png' } })
    expect(calls[0]!.url).toBe('/api/me')
    expect(calls[0]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      preferences: { export: { format: 'image/png' } },
    })
    expect(user.username).toBe('a')
  })

  /**
   * ★ 这条钉的是 me() 的**契约**：没登录不是错误。
   *
   * 打开页面时"没登录"是最常见的情况（每个新访客都是），所以它必须是返回值
   * null，而不是一个异常。让每个调用方各写一次 try/catch 去接一个正常情况，
   * 接不住的就不只是"显示登录页"——真正的故障（服务器挂了、响应读不动）
   * 会一起被那句 catch 吞掉，用户看到的是登录页而不是"出问题了"，
   * 排查时也看不见任何异常。
   */
  it('★ 没登录（401）时返回 null，**不抛** —— 这是它的契约', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }))))

    await expect(me()).resolves.toBeNull()
  })
})
