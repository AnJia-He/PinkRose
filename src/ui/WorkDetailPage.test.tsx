// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import type { WorkDetail } from '../../shared/works.ts'

const api = vi.hoisted(() => ({
  getWork: vi.fn(),
  renameWork: vi.fn(),
  deleteWork: vi.fn(),
  rateWork: vi.fn(),
  createWorkShare: vi.fn(),
  revokeWorkShare: vi.fn(),
}))

vi.mock('../api/works', () => ({
  ...api,
  fullUrl: (w: { id: number; updatedAt: number }) => `/api/works/${w.id}/file?v=${w.updatedAt}`,
}))

import { WorkDetailPage } from './WorkDetailPage'

const WORK: WorkDetail = {
  id: 9,
  alias: '海边',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  bytes: 1200,
  hasThumb: true,
  rating: 0,
  flag: 0,
  recipe: { params: ZERO, edits: [], lut: null },
  shareToken: null,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  api.getWork.mockResolvedValue(WORK)
  api.createWorkShare.mockResolvedValue({ token: 'AbCdEfGhIjKlMnOpQrStUvWx' })
  api.revokeWorkShare.mockResolvedValue(undefined)
  api.renameWork.mockResolvedValue(WORK)
  api.deleteWork.mockResolvedValue(undefined)
  api.rateWork.mockResolvedValue(WORK)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

const click = async (text: string) => {
  const btn = [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement
  expect(btn, `没有「${text}」按钮`).toBeTruthy()
  await act(async () => {
    btn.click()
    await new Promise(r => setTimeout(r, 0))
  })
}

describe('作品详情 · 分享链接', () => {
  it('生成 → 复制 → 停止分享；公开链接只出现在这一页', async () => {
    await act(async () => {
      root.render(
        <WorkDetailPage
          id={9}
          onBack={() => {}}
          onApply={() => {}}
          canApply
          onSavePreset={async () => {}}
        />,
      )
      await new Promise(r => setTimeout(r, 0))
    })
    expect(api.getWork).toHaveBeenCalledWith(9)

    await click('生成分享链接')
    expect(api.createWorkShare).toHaveBeenCalledWith(9)
    const input = container.querySelector('.detail-share-url') as HTMLInputElement
    expect(input.value).toMatch(/\/s\/AbCdEfGhIjKlMnOpQrStUvWx$/)

    await click('复制链接')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(input.value)
    expect([...container.querySelectorAll('button')]
      .some(b => (b.textContent ?? '').trim() === '已复制')).toBe(true)

    await click('停止分享')
    expect(api.revokeWorkShare).toHaveBeenCalledWith(9)
    expect(container.querySelector('.detail-share')).toBeNull()
  })

  it('★ 显示原文件名、机身、镜头和拍摄时间', async () => {
    api.getWork.mockResolvedValue({
      ...WORK,
      sourceName: 'IMG_1234.JPG',
      capturedAt: new Date(2026, 9, 20, 8, 15, 30).getTime(),
      cameraMake: 'SONY',
      cameraModel: 'ILCE-7CM2',
      lensModel: 'FE 50mm F1.4 GM',
    })

    await act(async () => {
      root.render(
        <WorkDetailPage
          id={9}
          onBack={() => {}}
          onApply={() => {}}
          canApply
          onSavePreset={async () => {}}
        />,
      )
      await new Promise(r => setTimeout(r, 0))
    })

    const source = container.querySelector('.detail-source')
    expect(source?.textContent).toContain('IMG_1234.JPG')
    expect(source?.textContent).toContain('SONY ILCE-7CM2')
    expect(source?.textContent).toContain('FE 50mm F1.4 GM')
    expect(source?.textContent).toContain('2026-10-20 08:15:30')
  })
})
