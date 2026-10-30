import { describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import { exportPhotoMovie } from './export'

function fakeFetch() {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body })
    if (url === '/api/video/session') {
      return new Response(JSON.stringify({ id: 'a'.repeat(24) }), { status: 200 })
    }
    if (url.endsWith('/finish')) {
      return new Response(new Blob(['mp4'], { type: 'video/mp4' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { impl, calls }
}

const photos = [
  new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
  new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' }),
]

const base = {
  photos,
  perPhotoMs: 1000,
  motion: 'in' as const,
  fps: 12 as const,
  aspect: 'source' as const,
  adjustments: ZERO,
}

describe('照片电影导出', () => {
  it('两张各 1 秒：24 帧分三批上传，收尾按顺序带时间轴', async () => {
    const { impl, calls } = fakeFetch()
    const rendered: string[] = []
    const blob = await exportPhotoMovie(base, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async (photoIndex, frameIndex, frames) => {
        rendered.push(`${photoIndex}:${frameIndex}/${frames}`)
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async (id, body) => {
        expect(id).toBe('a'.repeat(24))
        expect(body).toEqual({
          clips: [{ startMs: 0, durationMs: 2000 }],
          width: 1080,
          height: 1080,
          fps: 12,
          keepAudio: false,
          music: null,
        })
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(await blob.text()).toBe('mp4')
    expect(rendered).toHaveLength(24)
    expect(rendered[0]).toBe('0:0/12')
    expect(rendered[12]).toBe('1:0/12')
    const batches = calls.filter(c => c.url.endsWith('/frames'))
    expect(batches.map(b => JSON.parse(String(b.body)).frames.length)).toEqual([8, 8, 8])
    expect(calls.some(c => c.url.includes('/source'))).toBe(false)
  })

  it('配乐：上传音乐并按替换模式铺满全片', async () => {
    const { impl, calls } = fakeFetch()
    await exportPhotoMovie({
      ...base,
      music: {
        file: new File([new Uint8Array([9])], 'song.mp3', { type: 'audio/mpeg' }),
        volume: 45,
      },
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => 'data:image/jpeg;base64,AAAA',
      finish: async (_id, body) => {
        expect(body.music).toEqual({ mode: 'replace', volume: 45 })
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(calls.some(c => c.url.endsWith('/music'))).toBe(true)
  })

  it('取消：抛 AbortError 并删掉会话', async () => {
    const { impl, calls } = fakeFetch()
    const controller = new AbortController()
    let frames = 0
    await expect(exportPhotoMovie({
      ...base, signal: controller.signal,
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => {
        frames++
        if (frames === 2) controller.abort()
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async () => new Blob(['x']),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(frames).toBeLessThan(24)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })

  it('一张照片也要能出片（至少两帧）', async () => {
    const { impl } = fakeFetch()
    const rendered: number[] = []
    await exportPhotoMovie({
      ...base, photos: [photos[0]!], perPhotoMs: 1000,
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async (_p, _f, frames) => {
        rendered.push(frames)
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async () => new Blob(['mp4'], { type: 'video/mp4' }),
    })
    expect(rendered.length).toBeGreaterThanOrEqual(2)
  })

  it('淡入淡出：中间用混合帧替换两张的头尾，总帧数相应减少', async () => {
    const { impl } = fakeFetch()
    const frames: string[] = []
    const blends: string[] = []
    await exportPhotoMovie({
      ...base, transition: 'fade',
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async (photoIndex, frameIndex) => {
        frames.push(`${photoIndex}:${frameIndex}`)
        return 'data:image/jpeg;base64,AAAA'
      },
      renderBlend: async (fromPhoto, fromFrame, toPhoto, toFrame, _n, alpha) => {
        blends.push(`${fromPhoto}:${fromFrame}->${toPhoto}:${toFrame}@${alpha.toFixed(2)}`)
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async (_id, body) => {
        // 12fps × 1 秒 = 12 帧/张，重叠 4 帧 → 20 帧 ≈ 1667ms
        expect(body.clips).toEqual([{ startMs: 0, durationMs: 1667 }])
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(frames.slice(0, 2)).toEqual(['0:0', '0:1'])
    expect(frames).toContain('0:7')
    expect(frames).toContain('1:4')
    expect(frames).toContain('1:11')
    expect(blends).toEqual([
      '0:8->1:0@0.20',
      '0:9->1:1@0.40',
      '0:10->1:2@0.60',
      '0:11->1:3@0.80',
    ])
    expect(frames.length + blends.length).toBe(20)
  })
})
