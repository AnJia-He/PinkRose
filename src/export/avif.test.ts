// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { encodeAvif } from './avif'

function fakeCanvas(): HTMLCanvasElement {
  return {
    toBlob: (callback: BlobCallback, type?: string) => callback(
      type === 'image/webp'
        ? new Blob(['webp-bytes'], { type: 'image/webp' })
        : new Blob(['png-bytes'], { type: 'image/png' }),
    ),
  } as unknown as HTMLCanvasElement
}

describe('AVIF 导出', () => {
  it('优先用 WebP 中间图，按质量交给本机转换，返回 AVIF blob', async () => {
    const fetchMock = vi.fn(async () => new Response('avif-bytes', {
      status: 200, headers: { 'content-type': 'image/avif' },
    }))
    const blob = await encodeAvif(fakeCanvas(), 0.85, fetchMock as unknown as typeof fetch)
    expect(blob.size).toBe('avif-bytes'.length)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/convert/avif')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.quality).toBe(85)
    expect(body.image).toMatch(/^data:image\/webp;base64,/)
  })

  it('服务端说不行时透出可照做的提示', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ message: '这台电脑没有安装 ffmpeg' }), { status: 503 },
    ))
    await expect(encodeAvif(fakeCanvas(), 0.8, fetchMock as unknown as typeof fetch))
      .rejects.toThrow(/ffmpeg/)
  })
})
