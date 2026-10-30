import { describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import { exportVideo, type VideoClipSource } from './export'

function fakeFetch() {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, body: init?.body })
    if (url === '/api/video/session') {
      return new Response(JSON.stringify({ id: 'a'.repeat(24) }), { status: 200 })
    }
    if (url.endsWith('/finish')) {
      return new Response(new Blob(['mp4'], { type: 'video/mp4' }), { status: 200 })
    }
    if (url.endsWith('/frames')) {
      return new Response(JSON.stringify({ frames: 0 }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { impl, calls }
}

const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'video/mp4' })

function clip(
  name: string, url: string, startMs: number, endMs: number,
  width: number, height: number, durationMs: number,
): VideoClipSource {
  return { file: file(name), url, startMs, endMs, meta: { width, height, durationMs } }
}

const base = {
  video: null as unknown as HTMLVideoElement,
  fps: 24,
  adjustments: ZERO,
}

describe('短片导出编排', () => {
  it('两段：逐段取帧、按 8 帧一批、收尾按顺序带上每一段的起点和长度', async () => {
    const { impl, calls } = fakeFetch()
    const rendered: string[] = []
    const progress: string[] = []
    const blob = await exportVideo({
      ...base,
      clips: [
        clip('a.mp4', 'blob:a', 0, 500, 1920, 1080, 2000),
        clip('b.mp4', 'blob:b', 1000, 1500, 1920, 1080, 3000),
      ],
      onProgress: (done, total, stage) => progress.push(`${stage}:${done}/${total}`),
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async (index, time, filmTime) => {
        rendered.push(`${index}@${Math.round(time)}#${Math.round(filmTime)}`)
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async (id, body) => {
        expect(id).toBe('a'.repeat(24))
        expect(body).toEqual({
          clips: [
            { startMs: 0, durationMs: 500, sourceDurationMs: 500, speed: 1 },
            { startMs: 1000, durationMs: 500, sourceDurationMs: 500, speed: 1 },
          ],
          width: 1280,
          height: 720,
          fps: 24,
          keepAudio: true,
          music: null,
        })
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(await blob.text()).toBe('mp4')
    // 每段 0.5 秒 × 24fps = 12 帧，两段共 24 帧
    expect(rendered).toHaveLength(24)
    expect(rendered.slice(0, 2)).toEqual(['0@0#0', '0@42#42'])
    // 第二段从全片 0.5 秒开始：字幕时间轴按全片算
    expect(rendered.slice(12, 14)).toEqual(['1@1000#500', '1@1042#542'])
    const batches = calls.filter(c => c.url.endsWith('/frames'))
    expect(batches.map(b => JSON.parse(String(b.body)).frames.length)).toEqual([8, 8, 8])
    expect(calls.filter(c => c.url.includes('/source?index=')).map(c => c.url)).toEqual([
      '/api/video/session/aaaaaaaaaaaaaaaaaaaaaaaa/source?index=0',
      '/api/video/session/aaaaaaaaaaaaaaaaaaaaaaaa/source?index=1',
    ])
    expect(progress.at(-1)).toBe('encode:24/24')
  })

  it('渲染中途失败：不再传帧，并且把会话删掉', async () => {
    const { impl, calls } = fakeFetch()
    await expect(exportVideo({
      ...base,
      clips: [clip('a.mp4', 'blob:a', 0, 1000, 800, 600, 3000)],
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => { throw new Error('这一帧没取出来') },
      finish: async () => new Blob(['x']),
    })).rejects.toThrow(/没取出来/)
    expect(calls.filter(c => c.url.endsWith('/frames'))).toHaveLength(0)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })

  it('取消：抛 AbortError，不把剩下的帧算完', async () => {
    const { impl } = fakeFetch()
    const controller = new AbortController()
    let frames = 0
    await expect(exportVideo({
      ...base,
      clips: [clip('a.mp4', 'blob:a', 0, 2000, 800, 600, 3000)],
      signal: controller.signal,
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
  })

  it('关掉原声：不传源片；画幅按第一段算', async () => {
    const { impl, calls } = fakeFetch()
    const body = await exportVideo({
      ...base,
      keepAudio: false,
      aspect: '9:16',
      clips: [clip('a.mp4', 'blob:a', 0, 1000, 1920, 1080, 2000)],
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => 'data:image/jpeg;base64,AAAA',
      finish: async (_id, finishBody) => {
        expect(finishBody).toEqual({
          clips: [{ startMs: 0, durationMs: 1000, sourceDurationMs: 1000, speed: 1 }],
          width: 608,
          height: 1080,
          fps: 24,
          keepAudio: false,
          music: null,
        })
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(await body.text()).toBe('mp4')
    expect(calls.some(c => c.url.includes('/source'))).toBe(false)
  })

  it('几段加起来超过 20 秒：在开会话之前就拦住', async () => {
    const { impl, calls } = fakeFetch()
    await expect(exportVideo({
      ...base,
      clips: [
        clip('a.mp4', 'blob:a', 0, 15000, 800, 600, 20000),
        clip('b.mp4', 'blob:b', 0, 15000, 800, 600, 20000),
      ],
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => 'data:image/jpeg;base64,AAAA',
    })).rejects.toThrow(/不能超过 20 秒/)
    expect(calls).toHaveLength(0)
  })

  it('2× 导出：成片时长减半，收尾带上源片长度和速度', async () => {
    const { impl } = fakeFetch()
    const rendered: number[] = []
    await exportVideo({
      ...base,
      speed: 2,
      clips: [clip('a.mp4', 'blob:a', 0, 2000, 800, 600, 3000)],
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async (_clip, time) => {
        rendered.push(Math.round(time))
        return 'data:image/jpeg;base64,AAAA'
      },
      finish: async (_id, body) => {
        expect(body.clips).toEqual([
          { startMs: 0, durationMs: 1000, sourceDurationMs: 2000, speed: 2 },
        ])
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(rendered).toHaveLength(24)
    expect(rendered[0]).toBe(0)
    expect(rendered[1]).toBeGreaterThan(80) // 2× 时每两帧之间的源片跨度约 83ms
  })

  it('背景音乐混合：传音乐、传源片，收尾带模式和音量', async () => {
    const { impl, calls } = fakeFetch()
    await exportVideo({
      ...base,
      clips: [clip('a.mp4', 'blob:a', 0, 1000, 800, 600, 2000)],
      music: {
        file: new File([new Uint8Array([9])], 'song.mp3', { type: 'audio/mpeg' }),
        mode: 'mix',
        volume: 45,
      },
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => 'data:image/jpeg;base64,AAAA',
      finish: async (_id, body) => {
        expect(body.music).toEqual({ mode: 'mix', volume: 45 })
        expect(body.keepAudio).toBe(true)
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(calls.some(c => c.url.endsWith('/music'))).toBe(true)
    expect(calls.some(c => c.url.includes('/source?index=0'))).toBe(true)
  })

  it('替换原声：只传音乐，不传源片', async () => {
    const { impl, calls } = fakeFetch()
    await exportVideo({
      ...base,
      clips: [clip('a.mp4', 'blob:a', 0, 1000, 800, 600, 2000)],
      keepAudio: true,
      music: {
        file: new File([new Uint8Array([9])], 'song.mp3', { type: 'audio/mpeg' }),
        mode: 'replace',
        volume: 80,
      },
    }, {
      fetch: impl as unknown as typeof fetch,
      renderFrame: async () => 'data:image/jpeg;base64,AAAA',
      finish: async (_id, body) => {
        expect(body.music).toEqual({ mode: 'replace', volume: 80 })
        return new Blob(['mp4'], { type: 'video/mp4' })
      },
    })
    expect(calls.some(c => c.url.endsWith('/music'))).toBe(true)
    expect(calls.some(c => c.url.includes('/source'))).toBe(false)
  })
})
