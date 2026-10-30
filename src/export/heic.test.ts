// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeHeic, HEIC_SOURCE_LIMIT } from './heic'
import { getHeicCapability } from './heicCapability'

afterEach(() => vi.unstubAllGlobals())

function sourceCanvas(): HTMLCanvasElement {
  return {
    toBlob(callback: BlobCallback) {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
    },
  } as unknown as HTMLCanvasElement
}

describe('HEIC capability', () => {
  it('reports the server encoder that will be used', async () => {
    const doFetch = vi.fn(async () => Response.json({
      available: true,
      encoder: 'sips',
    }))
    await expect(getHeicCapability(doFetch)).resolves.toEqual({
      available: true,
      encoder: 'sips',
    })
    expect(doFetch).toHaveBeenCalledWith('/api/convert/heic/capability', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }))
  })

  it('treats a failed capability request as unavailable', async () => {
    await expect(getHeicCapability(async () => {
      throw new TypeError('offline')
    })).resolves.toEqual({ available: false, encoder: null })
  })
})

describe('encodeHeic', () => {
  it('posts the repaired canvas as JPEG and returns the HEIC blob', async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as { image: string; quality: number }
      expect(body.image).toMatch(/^data:image\/jpeg;base64,/)
      expect(body.quality).toBe(88)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/heic' },
      })
    })
    await expect(encodeHeic(sourceCanvas(), 0.88, doFetch)).resolves.toMatchObject({
      type: 'image/heic',
      size: 3,
    })
    expect(doFetch.mock.calls[0]![0]).toBe('/api/convert/heic')
  })

  it('surfaces the server reason when conversion is unavailable', async () => {
    const doFetch = vi.fn(async () => Response.json({
      message: '这台电脑没有 HEIC 编码器，换 JPG 导出。',
    }, { status: 503 }))
    await expect(encodeHeic(sourceCanvas(), 0.9, doFetch))
      .rejects.toThrow('换 JPG')
  })

  it('has a bounded source payload', () => {
    expect(HEIC_SOURCE_LIMIT).toBeGreaterThan(8 * 1024 * 1024)
    expect(HEIC_SOURCE_LIMIT).toBeLessThanOrEqual(32 * 1024 * 1024)
  })
})
