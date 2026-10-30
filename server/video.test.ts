import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  createVideoSession, deleteVideoSession, finishVideo, parseAudioProbe, parseVideoFinish,
  parseVideoFrameBatch, parseVideoProbe, saveVideoMusic, saveVideoSource,
  videoEncodeArgs, writeVideoFrames,
} from './video.ts'

const probeJson = JSON.stringify({
  streams: [
    { codec_type: 'video', width: 1920, height: 1080, duration: '3.2' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '3.2' },
})

const frame = `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`
const meta = { width: 640, height: 360, durationMs: 3000, hasAudio: true }

function fakeRequest(chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage
}

describe('短片探测', () => {
  it('读出宽高 / 时长，并认出有没有音轨', () => {
    expect(parseVideoProbe(probeJson)).toEqual({
      width: 1920, height: 1080, durationMs: 3200, hasAudio: true,
    })
    const silent = JSON.stringify({
      streams: [{ codec_type: 'video', width: 720, height: 1280 }],
      format: { duration: '1.05' },
    })
    expect(parseVideoProbe(silent)).toEqual({
      width: 720, height: 1280, durationMs: 1050, hasAudio: false,
    })
  })

  it('没有画面 / 不是 JSON 都回能照着做的话；没有时长头则记 0（MediaRecorder 的 WebM）', () => {
    expect(() => parseVideoProbe(JSON.stringify({
      streams: [{ codec_type: 'audio' }], format: { duration: '2' },
    }))).toThrow(/没有画面/)
    expect(parseVideoProbe(JSON.stringify({
      streams: [{ codec_type: 'video', width: 100, height: 100 }], format: {},
    }))).toMatchObject({ width: 100, height: 100, durationMs: 0 })
    expect(() => parseVideoProbe('not json')).toThrow(/读不出来/)
  })

  it('音乐探测：只认有音轨、能读出时长的文件', () => {
    expect(parseAudioProbe(probeJson)).toEqual({ durationMs: 3200 })
    expect(() => parseAudioProbe(JSON.stringify({
      streams: [{ codec_type: 'video', width: 10, height: 10 }],
      format: { duration: '2' },
    }))).toThrow(/没有声音/)
    expect(() => parseAudioProbe('nope')).toThrow(/读不出来/)
  })
})

describe('短片编码参数', () => {
  it('单段有原声：源片作第二路输入，-ss 排在源片输入之前', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: [{ file: 'C:\\tmp\\video\\source-0.bin', hasAudio: true }],
      clips: [{ startMs: 1500, durationMs: 1000 }],
      width: 1280, height: 720, fps: 24,
    })
    const line = args.join(' ')
    const ss = args.indexOf('-ss')
    expect(ss).toBeGreaterThan(-1)
    expect(args[ss + 1]).toBe('1.500')
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('C:\\tmp\\video\\source-0.bin'))
    expect(line).toContain('-map 0:v:0')
    expect(line).toContain('-map 1:a:0?')
    expect(line).toContain('-c:a aac')
    expect(line).toContain('-shortest')
    expect(line).toContain('scale=1280:720:flags=lanczos')
    expect(line).toContain('+faststart')
  })

  it('多段：每段自己的起点 + 音频截齐再 concat；没音轨的补静音', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: [
        { file: 'C:\\tmp\\video\\source-0.bin', hasAudio: true },
        { file: 'C:\\tmp\\video\\source-1.bin', hasAudio: false },
      ],
      clips: [
        { startMs: 0, durationMs: 500 },
        { startMs: 1200, durationMs: 800 },
      ],
      width: 1280, height: 720, fps: 24,
    })
    const line = args.join(' ')
    expect(line).toContain('-ss 1.200')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('[0:v]scale=1280:720:flags=lanczos,format=yuv420p[vout]')
    expect(graph).toContain('[1:a]atrim=duration=0.500')
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=0.800')
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[orig]')
    expect(line).toContain('-map [vout]')
    expect(line).toContain('-map [orig]')
    expect(line).not.toContain('-vf')
  })

  it('没有原声：不加输入，明确 -an', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video', sources: null,
      clips: [{ startMs: 0, durationMs: 1000 }],
      width: 1281, height: 721, fps: 99,
    })
    const line = args.join(' ')
    expect(line).toContain('-an')
    expect(line).not.toContain('-c:a')
    expect(line).toContain('-framerate 30')
    // 奇数尺寸先偶数化，不然 yuv420p 直接编不出来
    expect(line).toContain('scale=1282:722:flags=lanczos')
  })

  it('背景音乐混合：循环输入、按音量垫在原声下面', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: [{ file: 'C:\\tmp\\video\\source-0.bin', hasAudio: true }],
      clips: [{ startMs: 0, durationMs: 1200 }],
      music: { file: 'C:\\tmp\\video\\music.bin', volume: 60, mode: 'mix' },
      width: 640, height: 360, fps: 24,
    })
    const line = args.join(' ')
    expect(line).toContain('-stream_loop -1')
    expect(line).toContain('music.bin')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('[2:a]atrim=duration=1.200')
    expect(graph).toContain('volume=0.600')
    expect(graph).toContain('[a0][music]amix=inputs=2:duration=first:dropout_transition=0[mix]')
    expect(line).toContain('-map [mix]')
  })

  it('背景音乐替换原声：只映射音乐，不混原声', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: null,
      clips: [{ startMs: 0, durationMs: 800 }],
      music: { file: 'C:\\tmp\\video\\music.bin', volume: 100, mode: 'replace' },
      width: 640, height: 360, fps: 24,
    })
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('[1:a]atrim=duration=0.800')
    expect(graph).toContain('[music]')
    expect(graph).not.toContain('amix')
    expect(args.join(' ')).toContain('-map [music]')
  })

  it('关掉原声只留音乐：原声轨补静音再混，不会报缺输入', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: null,
      clips: [{ startMs: 0, durationMs: 600 }],
      music: { file: 'C:\\tmp\\video\\music.bin', volume: 50, mode: 'mix' },
      width: 640, height: 360, fps: 24,
    })
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=0.600')
    expect(graph).toContain('[orig][music]amix')
  })

  it('变速：音频按源片长度截取，再 atempo 拉伸到成片长度', () => {
    const args = videoEncodeArgs({
      dir: 'C:\\tmp\\video',
      sources: [{ file: 'C:\\tmp\\video\\source-0.bin', hasAudio: true }],
      clips: [{ startMs: 0, durationMs: 1000, sourceDurationMs: 2000, speed: 2 }],
      width: 640, height: 360, fps: 24,
    })
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('atrim=duration=2.000')
    expect(graph).toContain('atempo=2.00')
  })
})

describe('短片会话', () => {
  it('两段源片流式落盘 → 帧按序写入 → 编码后把临时目录整个删掉', async () => {
    const session = await createVideoSession(7)
    await saveVideoSource(fakeRequest([Buffer.from('part-one')]), session, 0, undefined,
      async () => meta)
    await saveVideoSource(fakeRequest([Buffer.from('part-two')]), session, 1, undefined,
      async () => meta)
    expect((await readFile(session.sources[0]!.file)).toString()).toBe('part-one')
    expect((await readFile(session.sources[1]!.file)).toString()).toBe('part-two')

    const batch = parseVideoFrameBatch({ startIndex: 0, frames: [frame, frame] }, session)
    expect(await writeVideoFrames(session, batch)).toBe(2)
    expect(existsSync(join(session.dir, 'frame-00001.jpg'))).toBe(true)

    const run = vi.fn(async (_cmd: string, args: readonly string[]) => {
      const out = args[args.length - 1]!
      await writeFile(out, 'mp4-bytes')
      return { stdout: Buffer.alloc(0), stderr: '' }
    })
    const bytes = await finishVideo(session, {
      clips: [{ startMs: 0, durationMs: 500 }, { startMs: 0, durationMs: 500 }],
      width: 640, height: 360, fps: 24, keepAudio: true, music: null,
    }, run)
    expect(Buffer.from(bytes).toString()).toBe('mp4-bytes')
    expect(run).toHaveBeenCalledWith('ffmpeg', expect.any(Array), 180_000)
    expect(existsSync(session.dir)).toBe(false)
  })

  it('帧顺序对不上 → 409，不写任何一帧', async () => {
    const session = await createVideoSession(8)
    try {
      expect(() => parseVideoFrameBatch({ startIndex: 3, frames: [frame] }, session))
        .toThrow(/顺序/)
      expect(session.frames).toBe(0)
    } finally {
      await deleteVideoSession(session.id, 8)
    }
  })

  it('一批超过 8 帧 / 不是 JPEG / 超过单帧上限都拒', async () => {
    const session = await createVideoSession(9)
    try {
      expect(() => parseVideoFrameBatch({
        startIndex: 0, frames: Array.from({ length: 9 }, () => frame),
      }, session)).toThrow(/最多传 8 帧/)
      expect(() => parseVideoFrameBatch({
        startIndex: 0, frames: ['data:image/png;base64,AAAA'],
      }, session)).toThrow(/格式/)
      const big = `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`
      expect(() => parseVideoFrameBatch({ startIndex: 0, frames: [big] }, session))
        .toThrow(/太大/)
    } finally {
      await deleteVideoSession(session.id, 9)
    }
  })

  it('收尾请求：段数 / 长度 / 合计 20 秒 / 原声都要对得上', async () => {
    const session = await createVideoSession(10)
    try {
      expect(() => parseVideoFinish({ clips: [], width: 640, height: 360, fps: 24 }, session))
        .toThrow(/至少要有一段/)
      expect(() => parseVideoFinish({
        clips: Array.from({ length: 7 }, () => ({ startMs: 0, durationMs: 500 })),
        width: 640, height: 360, fps: 24,
      }, session)).toThrow(/最多拼 6 段/)
      expect(() => parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }, { startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
      }, session)).toThrow(/原声还没传完/)

      await saveVideoSource(fakeRequest([Buffer.from('a')]), session, 0, undefined, async () => meta)
      await saveVideoSource(fakeRequest([Buffer.from('b')]), session, 1, undefined, async () => meta)
      expect(() => parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 15000 }, { startMs: 0, durationMs: 6000 }],
        width: 640, height: 360, fps: 24,
      }, session)).toThrow(/不能超过 20 秒/)
      expect(() => parseVideoFinish({
        clips: [{ startMs: 2800, durationMs: 500 }, { startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
      }, session)).toThrow(/超出了原片长度/)

      const batch = parseVideoFrameBatch({ startIndex: 0, frames: [frame, frame] }, session)
      await writeVideoFrames(session, batch)
      expect(parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }, { startMs: 1000, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
      }, session)).toEqual({
        clips: [
          { startMs: 0, durationMs: 500, sourceDurationMs: 500, speed: 1 },
          { startMs: 1000, durationMs: 500, sourceDurationMs: 500, speed: 1 },
        ],
        width: 640,
        height: 360,
        fps: 24,
        keepAudio: true,
        music: null,
      })
      expect(parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }, { startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24, keepAudio: false,
      }, session).keepAudio).toBe(false)
    } finally {
      await deleteVideoSession(session.id, 10)
    }
  })

  it('超过源片上限：拒绝并把半截文件删掉', async () => {
    const session = await createVideoSession(11)
    try {
      await expect(saveVideoSource(
        fakeRequest([Buffer.alloc(2048)]), session, 0, 1024,
      )).rejects.toThrow(/太大/)
      expect(existsSync(join(session.dir, 'source-0.bin'))).toBe(false)
    } finally {
      await deleteVideoSession(session.id, 11)
    }
  })

  it('背景音乐：流式落盘、收尾带上模式与音量；替换原声时不要求源片', async () => {
    const session = await createVideoSession(13)
    try {
      const batch = parseVideoFrameBatch({ startIndex: 0, frames: [frame, frame] }, session)
      await writeVideoFrames(session, batch)
      expect(() => parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
        music: { mode: 'mix', volume: 60 },
      }, session)).toThrow(/音乐还没传/)

      const music = await saveVideoMusic(
        fakeRequest([Buffer.from('mp3-bytes')]), session, undefined,
        async () => ({ durationMs: 2000 }),
      )
      expect(music.durationMs).toBe(2000)
      expect((await readFile(session.music!.file)).toString()).toBe('mp3-bytes')

      expect(parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
        music: { mode: 'replace', volume: 80 },
      }, session)).toMatchObject({
        clips: [{ startMs: 0, durationMs: 500 }],
        music: { mode: 'replace', volume: 80 },
      })
      expect(() => parseVideoFinish({
        clips: [{ startMs: 0, durationMs: 500 }],
        width: 640, height: 360, fps: 24,
        music: { mode: 'mix', volume: 400 },
      }, session)).toThrow(/音量/)
    } finally {
      await deleteVideoSession(session.id, 13)
    }
  })

  it('同一个账号只留两个会话：开第三个会把最旧的临时目录删掉', async () => {
    const first = await createVideoSession(12)
    const second = await createVideoSession(12)
    const third = await createVideoSession(12)
    try {
      expect(existsSync(first.dir)).toBe(false)
      expect(existsSync(second.dir)).toBe(true)
      expect(existsSync(third.dir)).toBe(true)
    } finally {
      await deleteVideoSession(second.id, 12)
      await deleteVideoSession(third.id, 12)
    }
  })
})
