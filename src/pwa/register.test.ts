// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { registerPwa } from './register.ts'

describe('PWA 注册', () => {
  it('生产入口在页面加载后注册 /sw.js', async () => {
    const register = vi.fn().mockResolvedValue({})
    const nav = { serviceWorker: { register } } as unknown as Navigator
    registerPwa(nav)
    window.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js'))
  })

  it('浏览器没有 Service Worker 时静默跳过', () => {
    expect(() => registerPwa({} as Navigator)).not.toThrow()
  })
})
