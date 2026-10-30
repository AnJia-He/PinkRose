import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from './http.ts'

/**
 * 照片视频 MP4（★ 2026-10-20）。
 *
 * 输入是已经按目标画幅合成好的 JPEG 数据 URL；服务端只做校验、落临时文件、
 * 调 ffmpeg 编码，再把 MP4 返回给浏览器。这样做的好处：
 *   · 苹果端不需要 MediaRecorder；
 *   · 不把用户的原始照片上传到云端，只传已缩到目标画幅的帧；
 *   · 编码参数固定，不把用户输入拼进 shell。
 */

export const MOTION_MAX_FRAMES = 12
export const MOTION_MAX_FRAME_BYTES = 3 * 1024 * 1024
export const MOTION_MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MOTION_MIN_MS = 200
export const MOTION_MAX_MS = 5000

export type MotionFrameRequest = {
  width: number
  height: number
  frameMs: number
  frames: Buffer[]
}

function integer(value: unknown, min: number, max: number, label: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError('BAD_REQUEST', `${label}要在 ${min}–${max} 之间。`, 400)
  }
  return n
}

export function parseMotionRequest(raw: unknown): MotionFrameRequest {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  if (!Array.isArray(body.frames) || body.frames.length < 2) {
    throw new HttpError('BAD_REQUEST', '照片视频至少要 2 张照片。', 400)
  }
  if (body.frames.length > MOTION_MAX_FRAMES) {
    throw new HttpError('BAD_REQUEST', `照片视频最多 ${MOTION_MAX_FRAMES} 张。`, 400)
  }
  const width = integer(body.width, 64, 1920, '视频宽度')
  const height = integer(body.height, 64, 1920, '视频高度')
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new HttpError('BAD_REQUEST', '视频宽高必须是偶数。', 400)
  }
  const frameMs = integer(body.frameMs, MOTION_MIN_MS, MOTION_MAX_MS, '每张停留时间')
  let total = 0
  const frames = body.frames.map((item, index) => {
    if (typeof item !== 'string') {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧不是图片。`, 400)
    }
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(item)
    if (!match) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧格式不对。`, 400)
    }
    const buffer = Buffer.from(match[1]!, 'base64')
    if (buffer.length === 0 || buffer.length > MOTION_MAX_FRAME_BYTES) {
      throw new HttpError('BAD_REQUEST', `第 ${index + 1} 帧太大了。`, 400)
    }
    total += buffer.length
    return buffer
  })
  if (total > MOTION_MAX_TOTAL_BYTES) {
    throw new HttpError('BAD_REQUEST', '这一组照片太大了，减到 8 张以内再试。', 400)
  }
  return { width, height, frameMs, frames }
}

/** 固定参数；测试也直接看这一份，避免文案和实际编码分离。 */
export function motionArgs(
  width: number, height: number, frameMs: number, dir: string,
): string[] {
  return [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(1000 / frameMs),
    '-i', join(dir, 'frame-%03d.jpg'),
    '-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-an',
    '-movflags', '+faststart',
    join(dir, 'motion.mp4'),
  ]
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error) => {
      if (!error) {
        resolve()
        return
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new HttpError(
          'INTERNAL',
          '这台电脑没有安装 ffmpeg，暂时导不出 MP4；GIF 仍然可以下载。',
          503,
        ))
        return
      }
      reject(new HttpError(
        'INTERNAL',
        '这台电脑的 ffmpeg 没把视频编出来；GIF 仍然可以下载。',
        500,
      ))
    })
  })
}

export async function renderMotionMp4(raw: unknown): Promise<Uint8Array> {
  const body = parseMotionRequest(raw)
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-motion-'))
  try {
    for (let i = 0; i < body.frames.length; i++) {
      await writeFile(join(dir, `frame-${String(i + 1).padStart(3, '0')}.jpg`), body.frames[i]!)
    }
    await runFfmpeg(motionArgs(body.width, body.height, body.frameMs, dir))
    return new Uint8Array(await readFile(join(dir, 'motion.mp4')))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
