/**
 * **HEIC 导出**（★ 2026-10-20）。
 *
 * 浏览器 canvas 不会编 HEIC。这里不内置一套未经硬件验证的容器实现，
 * 只调用本机已经安装的系统编码器：
 *   · macOS：系统自带的 `sips`；
 *   · 其他系统：支持 HEIC delegate 的 ImageMagick `magick`。
 *
 * 能力探测先于界面显示。没有编码器时客户端不会出现 HEIC 选项，
 * 避免用户切到一个点了必然失败的格式。服务端仍然再检查一次。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from './http.ts'

export const HEIC_MAX_SOURCE_BYTES = 24 * 1024 * 1024

const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]*)$/

export type HeicEncoder = 'sips' | 'magick'
export type HeicCapability = {
  available: boolean
  encoder: HeicEncoder | null
}

export type HeicRequest = {
  buffer: Buffer
  quality: number
}

type Runner = (command: string, args: string[], timeout: number) => Promise<void>
type Probe = (encoder: HeicEncoder) => Promise<boolean>

const defaultRunner: Runner = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, error => {
      if (!error) {
        resolve()
        return
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new HttpError(
          'INTERNAL',
          '这台电脑没有 HEIC 编码器，换 JPG 或 WebP 导出。',
          503,
        ))
        return
      }
      reject(new HttpError('INTERNAL', 'HEIC 没转出来，换 JPG 或 WebP 导出。', 500))
    })
  })

const defaultProbe: Probe = async (encoder) => {
  if (encoder === 'sips') {
    if (process.platform !== 'darwin') return false
    return new Promise(resolve => {
      execFile('sips', ['--help'], { timeout: 2_000 }, error => resolve(!error))
    })
  }
  return new Promise(resolve => {
    execFile(
      'magick',
      ['-list', 'format'],
      { timeout: 4_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(!error && /\bHEIC\b/i.test(stdout)),
    )
  })
}

/** 优先用 macOS 系统能力，其次找 ImageMagick 的 HEIC delegate。 */
export async function detectHeicEncoder(probe: Probe = defaultProbe): Promise<HeicEncoder | null> {
  if (await probe('sips').catch(() => false)) return 'sips'
  if (await probe('magick').catch(() => false)) return 'magick'
  return null
}

export function parseHeicRequest(raw: unknown): HeicRequest {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  if (typeof body.image !== 'string') {
    throw new HttpError('BAD_REQUEST', '没有收到要转换的图片。', 400)
  }
  const match = DATA_URL.exec(body.image)
  if (!match) {
    throw new HttpError('BAD_REQUEST', '只支持 PNG / JPG / WebP 转 HEIC。', 400)
  }
  const buffer = Buffer.from(match[1]!, 'base64')
  if (buffer.length === 0) {
    throw new HttpError('BAD_REQUEST', '这张图是空的。', 400)
  }
  if (buffer.length > HEIC_MAX_SOURCE_BYTES) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，先缩到 24MB 以内。', 413)
  }
  const rawQuality = Number(body.quality ?? 90)
  const quality = Number.isFinite(rawQuality)
    ? Math.round(Math.max(0, Math.min(100, rawQuality)))
    : 90
  return { buffer, quality }
}

export function heicEncoderArgs(
  encoder: HeicEncoder, input: string, output: string, quality: number,
): string[] {
  if (encoder === 'sips') {
    return [
      '-s', 'format', 'heic',
      '-s', 'formatOptions', String(quality),
      input,
      '--out', output,
    ]
  }
  return [input, '-quality', String(quality), output]
}

export async function convertToHeic(
  raw: unknown,
  options: {
    encoder?: HeicEncoder | null
    run?: Runner
    probe?: Probe
  } = {},
): Promise<Uint8Array> {
  const request = parseHeicRequest(raw)
  const encoder = options.encoder !== undefined
    ? options.encoder
    : await detectHeicEncoder(options.probe)
  if (!encoder) {
    throw new HttpError(
      'INTERNAL',
      '这台电脑没有 HEIC 编码器。Mac 自带 sips，其他系统装带 HEIC 支持的 ImageMagick 后再试；也可以直接导出 JPG / WebP。',
      503,
    )
  }
  const run = options.run ?? defaultRunner
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-heic-'))
  const input = join(dir, 'in.jpg')
  const output = join(dir, 'out.heic')
  try {
    await writeFile(input, request.buffer)
    await run(
      encoder,
      heicEncoderArgs(encoder, input, output, request.quality),
      60_000,
    )
    const bytes = await readFile(output)
    if (bytes.length === 0) {
      throw new HttpError('INTERNAL', 'HEIC 转出来是空的，换 JPG 或 WebP 导出。', 500)
    }
    return new Uint8Array(bytes)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

let cachedCapability: Promise<HeicCapability> | null = null

/** 能力探测按进程缓存；同一台机器不必每开一次导出面板都问一遍。 */
export function getHeicCapability(): Promise<HeicCapability> {
  if (!cachedCapability) {
    cachedCapability = detectHeicEncoder().then(encoder => ({
      available: encoder !== null,
      encoder,
    }))
  }
  return cachedCapability
}
