/**
 * **短片调色的服务端**（★ 2026-10-20）。
 *
 * 浏览器负责"看"和"修"：逐帧解出来、走同一条 `TonePipeline`、编成 JPEG；
 * 服务端负责"装"：把帧按顺序收进临时目录，再让 ffmpeg 编成 H.264，
 * **原声从源视频里原样接回来**。这样苹果端不需要 MediaRecorder，
 * 成片和照片用的是同一套调色公式，导出结果不会"照片一个样、视频另一个样"。
 *
 * 为什么不是一个请求把所有帧塞进 JSON：
 *   · 20 秒 24fps 是 480 帧，base64 之后轻松几十 MB；
 *   · 一次性读进内存，弱一点的机器（尤其 iPad）会先被浏览器掐掉。
 * 所以拆成"开会话 → 传源片（流式）→ 分批传帧 → 收尾编码 → 删会话"。
 *
 * ⚠️ 会话是**临时的**：进程内 Map + 系统临时目录，30 分钟没人动就整个删掉；
 *   进程重启后旧会话失效（前端拿 404 就重新开一个，不需要持久化）。
 * ⚠️ ffmpeg 的参数是固定的，用户输入只进"数值"和"尺寸"，不拼 shell。
 */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { HttpError } from './http.ts'
import {
  VIDEO_FRAME_BATCH, VIDEO_MAX_CLIPS, VIDEO_MAX_FRAME_BYTES, VIDEO_MAX_SECONDS,
  VIDEO_MAX_SOURCE_BYTES, VIDEO_MAX_TOTAL_FRAMES,
} from '../shared/video.ts'

/** 会话闲置多久就清掉（毫秒）。 */
export const VIDEO_SESSION_TTL_MS = 30 * 60 * 1000

/** 一帧的 data URL 必须是 JPEG：PNG 一张 1280px 会到几 MB，不值得。 */
const FRAME_DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/

export type VideoCommandRunner = (
  command: string,
  args: readonly string[],
  timeout: number,
) => Promise<{ stdout: Buffer; stderr: string }>

export const defaultVideoCommandRunner: VideoCommandRunner = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
        if (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new HttpError(
              'INTERNAL',
              '这台电脑没有安装 ffmpeg，导不出短片；先装 ffmpeg 再试。',
              503,
            ))
            return
          }
          reject(new HttpError(
            'INTERNAL',
            err.trim() ? `短片没编码成功：${err.trim().slice(0, 200)}` : '短片没编码成功。',
            500,
          ))
          return
        }
        resolve({ stdout: out, stderr: err })
      },
    )
  })

export type VideoMeta = {
  width: number
  height: number
  durationMs: number
  hasAudio: boolean
}

type StreamInfo = {
  codec_type?: string
  width?: number
  height?: number
  duration?: string
}

/**
 * 解析 `ffprobe -print_format json -show_streams -show_format` 的输出。
 * 抽出来单独测：手机拍的 MOV 里常见"旋转元数据 + 音频轨"，读错宽高会导出黑边。
 */
export function parseVideoProbe(text: string): VideoMeta {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new HttpError('BAD_REQUEST', '这段视频读不出来，换一个文件试试。', 400)
  }
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const streams = Array.isArray(body.streams) ? body.streams as StreamInfo[] : []
  const video = streams.find(s => s.codec_type === 'video')
  if (!video || !video.width || !video.height) {
    throw new HttpError('BAD_REQUEST', '这个文件里没有画面，换一段视频试试。', 400)
  }
  const format = body.format && typeof body.format === 'object'
    ? body.format as Record<string, unknown> : {}
  const durationText = typeof format.duration === 'string'
    ? format.duration
    : typeof video.duration === 'string' ? video.duration : ''
  const seconds = Number(durationText)
  // ⚠️ MediaRecorder 录出来的 WebM **没有时长头**（ffprobe 给 N/A）。
  // 这种文件仍然可以正常解码和编码；时长只在"段是否超出源片"的校验里用到，
  // 所以这里返回 0（未知），由 `parseVideoFinish` 跳过那一条边界检查。
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
  return {
    width: Math.round(video.width),
    height: Math.round(video.height),
    durationMs,
    hasAudio: streams.some(s => s.codec_type === 'audio'),
  }
}

export async function probeVideo(
  file: string, run: VideoCommandRunner = defaultVideoCommandRunner,
): Promise<VideoMeta> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    20_000,
  )
  return parseVideoProbe(stdout.toString('utf8'))
}

/** 解析 ffprobe 的音频输出：只关心时长（循环补足时要用）和有没有音轨。 */
export function parseAudioProbe(text: string): { durationMs: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new HttpError('BAD_REQUEST', '这段音乐读不出来，换一个文件试试。', 400)
  }
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const streams = Array.isArray(body.streams) ? body.streams as StreamInfo[] : []
  const audio = streams.find(s => s.codec_type === 'audio')
  if (!audio) {
    throw new HttpError('BAD_REQUEST', '这个文件里没有声音，换一段音乐试试。', 400)
  }
  const format = body.format && typeof body.format === 'object'
    ? body.format as Record<string, unknown> : {}
  const seconds = Number(typeof format.duration === 'string'
    ? format.duration
    : typeof audio.duration === 'string' ? audio.duration : '')
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new HttpError('BAD_REQUEST', '这段音乐读不出时长，换一个文件试试。', 400)
  }
  return { durationMs: Math.round(seconds * 1000) }
}

export async function probeAudio(
  file: string, run: VideoCommandRunner = defaultVideoCommandRunner,
): Promise<{ durationMs: number }> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    20_000,
  )
  return parseAudioProbe(stdout.toString('utf8'))
}

/** 偶数化（H.264 yuv420p 的硬要求）。 */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export type VideoEncodeSource = { file: string; hasAudio: boolean }
export type VideoEncodeClip = {
  startMs: number
  /** 成片（变速之后）时长。 */
  durationMs: number
  /** 源片区间时长；缺省等于 durationMs。 */
  sourceDurationMs?: number
  /** 变速倍数；缺省 1。 */
  speed?: number
}
export type VideoMusicInput = {
  file: string
  /** 0–100，和界面上的音量滑杆同一个量纲。 */
  volume: number
  mode: 'mix' | 'replace'
}

/**
 * 编码参数（★ 2026-10-20 多段拼接）。
 *
 * `sources = null` 表示静音：只编画面。
 * 一段：`-ss` 跳源片的起点 + `-map 1:a:0?`（问号 = 没音轨也不报错）。
 * 多段：每段按自己的起点 `-ss`，音频用 `atrim` 截到和画面一样长，
 * 再 `concat` 成一条；**没有音轨的片段补等长静音**，否则后面的声音会整体前移。
 */
export function videoEncodeArgs(
  opts: {
    dir: string
    sources: VideoEncodeSource[] | null
    clips: VideoEncodeClip[]
    /** 背景音乐；null = 不加。 */
    music?: VideoMusicInput | null
    width: number
    height: number
    fps: number
  },
): string[] {
  const width = even(opts.width)
  const height = even(opts.height)
  const fps = Math.min(30, Math.max(1, Math.round(opts.fps)))
  const args = [
    '-y', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', join(opts.dir, 'frame-%05d.jpg'),
  ]
  const sources = opts.sources
  if (sources && sources.length > 0) {
    for (const [index, source] of sources.entries()) {
      const startMs = Math.max(0, Math.round(opts.clips[index]?.startMs ?? 0))
      if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3))
      args.push('-i', source.file)
    }
  }
  const music = opts.music ?? null
  if (music) {
    // 音乐文件短了就循环；`atrim` 会在成片长度处截断。
    args.push('-stream_loop', '-1', '-i', music.file)
  }

  const videoFilter = `scale=${width}:${height}:flags=lanczos,format=yuv420p`
  const totalSeconds = Math.max(0.05,
    opts.clips.reduce((sum, clip) => sum + Math.max(0, clip.durationMs), 0) / 1000).toFixed(3)
  const speedNeedsFilter = !!sources
    && sources.length > 0
    && opts.clips.some(clip => (clip.speed ?? 1) !== 1)
  if (music || speedNeedsFilter || (sources && sources.length > 1)) {
    const parts: string[] = [`[0:v]${videoFilter}[vout]`]
    const audioTail = 'asetpts=PTS-STARTPTS,aresample=48000,'
      + 'aformat=sample_fmts=fltp:channel_layouts=stereo'
    let audioLabel: string | null = null
    if (sources && sources.length > 0) {
      for (const [index, source] of sources.entries()) {
        const clip = opts.clips[index]
        const sourceDuration = Math.max(0.05,
          (clip?.sourceDurationMs ?? clip?.durationMs ?? 0) / 1000).toFixed(3)
        const outDuration = Math.max(0.05, (clip?.durationMs ?? 0) / 1000).toFixed(3)
        const speed = clip?.speed ?? 1
        const tempo = speed !== 1 ? `,atempo=${speed.toFixed(2)}` : ''
        if (source.hasAudio) {
          parts.push(`[${index + 1}:a]atrim=duration=${sourceDuration},${audioTail}${tempo}[a${index}]`)
        } else {
          // 没有音轨的段补**成片**长度（不需要 atempo）。
          parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${outDuration},${audioTail}[a${index}]`)
        }
      }
      if (sources.length === 1) {
        audioLabel = 'a0'
      } else {
        parts.push(`${sources.map((_, index) => `[a${index}]`).join('')}`
          + `concat=n=${sources.length}:v=0:a=1[orig]`)
        audioLabel = 'orig'
      }
    }
    if (music) {
      const musicIndex = 1 + (sources?.length ?? 0)
      const volume = Math.min(2, Math.max(0, music.volume / 100)).toFixed(3)
      const musicTail = `asetpts=PTS-STARTPTS,volume=${volume},`
        + 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'
      parts.push(`[${musicIndex}:a]atrim=duration=${totalSeconds},${musicTail}[music]`)
      if (music.mode === 'replace') {
        audioLabel = 'music'
      } else {
        if (!audioLabel) {
          parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${totalSeconds},${audioTail}[orig]`)
          audioLabel = 'orig'
        }
        parts.push(`[${audioLabel}][music]amix=inputs=2:duration=first:dropout_transition=0[mix]`)
        audioLabel = 'mix'
      }
    }
    if (!audioLabel) {
      // 理论上走不到（这个分支只在有 music 或多段时进入）；保底给一条静音。
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${totalSeconds},${audioTail}[orig]`)
      audioLabel = 'orig'
    }
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[vout]',
      '-map', `[${audioLabel}]`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
    )
  } else {
    args.push(
      '-map', '0:v:0',
      ...(sources ? ['-map', '1:a:0?'] : []),
      '-vf', videoFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
    )
    if (sources) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    else args.push('-an')
  }
  args.push('-movflags', '+faststart', join(opts.dir, 'out.mp4'))
  return args
}

export type VideoSource = { file: string; meta: VideoMeta }
export type VideoMusicFile = { file: string; durationMs: number }

export type VideoSession = {
  id: string
  dir: string
  owner: number
  createdAt: number
  /** 第 i 段的源片（为了原声）；静音导出时一个都不传。 */
  sources: (VideoSource | null)[]
  /** 背景音乐；没选就是 null。 */
  music: VideoMusicFile | null
  frames: number
}

const sessions = new Map<string, VideoSession>()

function sessionError(): HttpError {
  return new HttpError('BAD_REQUEST', '这次导出的会话已经过期了，重新点一次导出。', 404)
}

function sweep(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > VIDEO_SESSION_TTL_MS) {
      sessions.delete(id)
      void rm(session.dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 开一个临时会话。目录名带随机 id，**不放在用户目录**。 */
export async function createVideoSession(owner: number): Promise<VideoSession> {
  sweep()
  // 同一个账号最多留两个会话：临时目录不是无限仓库，开新的先把最旧的删掉。
  const mine = [...sessions.values()]
    .filter(s => s.owner === owner)
    .sort((a, b) => a.createdAt - b.createdAt)
  while (mine.length >= 2) {
    const oldest = mine.shift()!
    sessions.delete(oldest.id)
    await rm(oldest.dir, { recursive: true, force: true }).catch(() => {})
  }
  const id = randomBytes(12).toString('hex')
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-video-'))
  const session: VideoSession = {
    id, dir, owner, createdAt: Date.now(), sources: [], music: null, frames: 0,
  }
  sessions.set(id, session)
  return session
}

export function getVideoSession(id: string, owner: number): VideoSession {
  sweep()
  const session = sessions.get(id)
  if (!session || session.owner !== owner) throw sessionError()
  return session
}

export async function deleteVideoSession(id: string, owner: number): Promise<void> {
  const session = sessions.get(id)
  if (!session || session.owner !== owner) return
  sessions.delete(id)
  await rm(session.dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * 把源视频**流式**写进会话目录，再探测一次宽高 / 时长 / 有没有声音。
 * 超限时立刻停止写入并删掉半截文件 —— 不能把 512MB 的残片留在盘上。
 */
export async function saveVideoSource(
  req: IncomingMessage,
  session: VideoSession,
  index: number,
  limitBytes = VIDEO_MAX_SOURCE_BYTES,
  probe: (file: string) => Promise<VideoMeta> = probeVideo,
): Promise<VideoMeta> {
  if (!Number.isInteger(index) || index < 0 || index >= VIDEO_MAX_CLIPS) {
    throw new HttpError('BAD_REQUEST', '片段的编号不对。', 400)
  }
  const target = join(session.dir, `source-${index}.bin`)
  try {
    await saveRequestToFile(req, target, limitBytes, '这段视频太大了，先压到 512MB 以内再导入。')
    const meta = await probe(target)
    session.sources[index] = { file: target, meta }
    return meta
  } catch (e) {
    await rm(target, { force: true }).catch(() => {})
    session.sources[index] = null
    throw e
  }
}

/**
 * 背景音乐：最多 32MB（一首歌绰绰有余），只认有音轨的文件。
 * 存成 `music.bin`，编码时按成片长度循环 / 截断。
 */
export async function saveVideoMusic(
  req: IncomingMessage,
  session: VideoSession,
  limitBytes = 32 * 1024 * 1024,
  probe: (file: string) => Promise<{ durationMs: number }> = probeAudio,
): Promise<{ durationMs: number }> {
  const target = join(session.dir, 'music.bin')
  try {
    await saveRequestToFile(req, target, limitBytes, '这段音乐太大了，选 32MB 以内的文件。')
    const meta = await probe(target)
    session.music = { file: target, durationMs: meta.durationMs }
    return meta
  } catch (e) {
    await rm(target, { force: true }).catch(() => {})
    session.music = null
    throw e
  }
}

/** 把请求体流式写进文件；超限立刻停下并清掉半截文件。 */
async function saveRequestToFile(
  req: IncomingMessage,
  target: string,
  limitBytes: number,
  tooLarge: string,
): Promise<number> {
  const out = createWriteStream(target)
  try {
    const size = await new Promise<number>((resolve, reject) => {
      let bytes = 0
      let settled = false
      const fail = (e: Error) => {
        if (settled) return
        settled = true
        out.destroy()
        reject(e)
      }
      req.on('data', (chunk: Buffer) => {
        if (settled) return
        bytes += chunk.length
        if (bytes > limitBytes) {
          fail(new HttpError('BAD_REQUEST', tooLarge, 413))
          return
        }
        if (!out.write(chunk)) req.pause()
      })
      out.on('drain', () => req.resume())
      req.on('end', () => {
        if (settled) return
        settled = true
        out.end(() => resolve(bytes))
      })
      req.on('error', fail)
      out.on('error', fail)
    })
    if (size === 0) {
      throw new HttpError('BAD_REQUEST', '这个文件是空的，换一个试试。', 400)
    }
    return size
  } catch (e) {
    if (!out.destroyed) {
      out.destroy()
      await new Promise<void>(resolve => out.once('close', () => resolve()))
    }
    await rm(target, { force: true }).catch(() => {})
    throw e
  }
}

export type VideoFrameBatch = { startIndex: number; frames: Buffer[] }

/** 校验一批帧。`startIndex` 必须是会话当前帧数，乱序会变成"错位的视频"。 */
export function parseVideoFrameBatch(
  raw: unknown, session: VideoSession,
): VideoFrameBatch {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const startIndex = body.startIndex
  if (!Number.isInteger(startIndex) || (startIndex as number) !== session.frames) {
    throw new HttpError('CONFLICT', '帧的顺序对不上，重新导出一次。', 409)
  }
  if (!Array.isArray(body.frames) || body.frames.length === 0) {
    throw new HttpError('BAD_REQUEST', '这一批里没有帧。', 400)
  }
  if (body.frames.length > VIDEO_FRAME_BATCH) {
    throw new HttpError('BAD_REQUEST', `一次最多传 ${VIDEO_FRAME_BATCH} 帧。`, 400)
  }
  if (session.frames + body.frames.length > VIDEO_MAX_TOTAL_FRAMES) {
    throw new HttpError('BAD_REQUEST', '帧数超过上限了，先把片子剪短一点。', 400)
  }
  const frames = body.frames.map((item, index) => {
    if (typeof item !== 'string') {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧不是图片。`, 400)
    }
    const match = FRAME_DATA_URL.exec(item)
    if (!match) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧格式不对。`, 400)
    }
    const buffer = Buffer.from(match[1]!, 'base64')
    if (buffer.length === 0 || buffer.length > VIDEO_MAX_FRAME_BYTES) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧太大了。`, 400)
    }
    return buffer
  })
  return { startIndex: startIndex as number, frames }
}

export async function writeVideoFrames(session: VideoSession, batch: VideoFrameBatch): Promise<number> {
  for (let i = 0; i < batch.frames.length; i++) {
    const name = `frame-${String(batch.startIndex + i + 1).padStart(5, '0')}.jpg`
    await writeFile(join(session.dir, name), batch.frames[i]!)
  }
  session.frames += batch.frames.length
  return session.frames
}

export type VideoFinishRequest = {
  /** 每一段在原片里的起点和长度；顺序就是成片顺序。 */
  clips: { startMs: number; durationMs: number }[]
  width: number
  height: number
  fps: number
  /** 关掉就明确不带音轨（连源片都不用读）。 */
  keepAudio: boolean
  /** 背景音乐：混合或替换；null = 不加。 */
  music: { mode: 'mix' | 'replace'; volume: number } | null
}

export function parseVideoFinish(raw: unknown, session: VideoSession): VideoFinishRequest {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const width = Number(body.width)
  const height = Number(body.height)
  const fps = Number(body.fps)
  if (!Array.isArray(body.clips) || body.clips.length < 1) {
    throw new HttpError('BAD_REQUEST', '至少要有一段画面。', 400)
  }
  if (body.clips.length > VIDEO_MAX_CLIPS) {
    throw new HttpError('BAD_REQUEST', `最多拼 ${VIDEO_MAX_CLIPS} 段。`, 400)
  }
  let total = 0
  const clips = body.clips.map((item, index) => {
    const clip = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const startMs = Number(clip.startMs)
    const durationMs = Number(clip.durationMs)
    const sourceDurationMs = Number(clip.sourceDurationMs ?? durationMs)
    const speed = Number(clip.speed ?? 1)
    if (!Number.isFinite(startMs) || startMs < 0 || startMs > 10 * 60 * 1000) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段的起点不对。`, 400)
    }
    if (!Number.isFinite(durationMs) || durationMs < 50
      || durationMs > VIDEO_MAX_SECONDS * 1000) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段的长度不对。`, 400)
    }
    if (!Number.isFinite(sourceDurationMs) || sourceDurationMs < 50
      || sourceDurationMs > 10 * 60 * 1000) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段的源片长度不对。`, 400)
    }
    if (![0.5, 1, 2].includes(speed)) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段的速度不对。`, 400)
    }
    total += durationMs
    return {
      startMs: Math.round(startMs),
      durationMs: Math.round(durationMs),
      sourceDurationMs: Math.round(sourceDurationMs),
      speed,
    }
  })
  if (total > VIDEO_MAX_SECONDS * 1000) {
    throw new HttpError('BAD_REQUEST', `几段加起来不能超过 ${VIDEO_MAX_SECONDS} 秒。`, 400)
  }
  const keepAudio = body.keepAudio !== false
  const musicRaw = body.music && typeof body.music === 'object'
    ? body.music as Record<string, unknown> : null
  let music: VideoFinishRequest['music'] = null
  if (musicRaw) {
    const mode = musicRaw.mode === 'replace' ? 'replace' : 'mix'
    const volume = Number(musicRaw.volume ?? 60)
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new HttpError('BAD_REQUEST', '背景音乐的音量不对。', 400)
    }
    if (!session.music) {
      throw new HttpError('BAD_REQUEST', '背景音乐还没传上来，重新导出一次。', 400)
    }
    music = { mode, volume: Math.round(volume) }
  }
  // 替换原声时不需要（也不该要求）源片。
  const needSources = keepAudio && music?.mode !== 'replace'
  if (needSources) {
    if (session.sources.length !== clips.length) {
      throw new HttpError('BAD_REQUEST', '原声还没传完，重新导出一次。', 400)
    }
    clips.forEach((clip, index) => {
      const source = session.sources[index]
      if (!source) {
        throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段原声没传上来，重新导出一次。`, 400)
      }
      if (source.meta.durationMs > 0
        && clip.startMs + clip.sourceDurationMs > source.meta.durationMs + 200) {
        throw new HttpError('BAD_REQUEST', `第 ${index + 1} 段超出了原片长度。`, 400)
      }
    })
  }
  if (!Number.isInteger(width) || width < 16 || width > 4096) {
    throw new HttpError('BAD_REQUEST', '输出宽度不对。', 400)
  }
  if (!Number.isInteger(height) || height < 16 || height > 4096) {
    throw new HttpError('BAD_REQUEST', '输出高度不对。', 400)
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) {
    throw new HttpError('BAD_REQUEST', '输出帧率不对。', 400)
  }
  if (session.frames < 2) {
    throw new HttpError('BAD_REQUEST', '至少要有两帧才能导出。', 400)
  }
  return { clips, width, height, fps, keepAudio, music }
}

/**
 * 收尾：编码 → 读回字节 → **无论成功失败都删临时目录**。
 * 返回的 MP4 直接进响应体，不落到用户的作品目录（这一版短片是"下载"，
 * 不是"存进作品"；要存的时候用户可以从下载里再导入）。
 */
export async function finishVideo(
  session: VideoSession,
  request: VideoFinishRequest,
  run: VideoCommandRunner = defaultVideoCommandRunner,
): Promise<Uint8Array> {
  const output = join(session.dir, 'out.mp4')
  try {
    await run('ffmpeg', videoEncodeArgs({
      dir: session.dir,
      sources: request.keepAudio && request.music?.mode !== 'replace'
        ? request.clips.map((_, index) => {
          const source = session.sources[index]!
          return { file: source.file, hasAudio: source.meta.hasAudio }
        })
        : null,
      clips: request.clips,
      music: request.music && session.music
        ? {
          file: session.music.file,
          volume: request.music.volume,
          mode: request.music.mode,
        }
        : null,
      width: request.width,
      height: request.height,
      fps: request.fps,
    }), 180_000)
    const info = await stat(output)
    if (!info.size) throw new HttpError('INTERNAL', '短片编码出来是空的，再试一次。', 500)
    return new Uint8Array(await readFile(output))
  } finally {
    sessions.delete(session.id)
    await rm(session.dir, { recursive: true, force: true }).catch(() => {})
  }
}
