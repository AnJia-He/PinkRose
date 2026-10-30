// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getSharedWork: vi.fn(),
}))

vi.mock('../api/works', () => ({
  ...api,
  sharedImageUrl: (token: string, updatedAt: number, kind = 'image') =>
    `/api/share/${token}/${kind}?v=${updatedAt}`,
}))

import SharedWorkPage from './SharedWorkPage'
import { ApiError } from '../api/client'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('公开分享页', () => {
  it('免登录显示作品名 / 大图 / 回 PinkRose 的入口', async () => {
    api.getSharedWork.mockResolvedValue({
      token: 'AbCdEfGhIjKlMnOpQrStUvWx',
      alias: '海边',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      hasThumb: true,
    })
    await act(async () => {
      root.render(<SharedWorkPage token="AbCdEfGhIjKlMnOpQrStUvWx" onHome={() => {}} />)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(api.getSharedWork).toHaveBeenCalledWith('AbCdEfGhIjKlMnOpQrStUvWx')
    expect(container.querySelector('h1')?.textContent).toBe('海边')
    expect((container.querySelector('.shared-image') as HTMLImageElement).src)
      .toContain('/api/share/AbCdEfGhIjKlMnOpQrStUvWx/image')
    expect([...container.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').includes('用 PinkRose'))).toBe(true)
  })

  it('token 失效 → 给可重试的错误页，不白屏', async () => {
    api.getSharedWork.mockRejectedValue(new ApiError('BAD_REQUEST', '这个分享链接不在了', 404))
    await act(async () => {
      root.render(<SharedWorkPage token="AbCdEfGhIjKlMnOpQrStUvWx" onHome={() => {}} />)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.textContent).toContain('这个分享链接不在了')
    expect([...container.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').includes('去 PinkRose'))).toBe(true)
  })
})
