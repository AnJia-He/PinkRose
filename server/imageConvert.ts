/**
 * **AVIF 导出**（★ 2026-10-20）。
 *
 * 浏览器的 canvas 不会编 AVIF，但本机的 ffmpeg 可以（libaom-av1）。
 * 客户端把**已经修好的图**编成 WebP（不可用时退回 PNG）发过来，这里只做格式转换：
 *   · 仍是本机处理，不上云端；
 *   · 参数固定，用户输入只进 CRF（数值），不拼 shell；
 *   · 临时文件用完即删。
 *
 * 为什么值得多这一步：同一个画面，AVIF 通常比 JPG 小 40–60%，
 * 而 Safari 16.4+ / iOS 16.4+ 原生支持显示。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from './http.ts'

/** 解码后的源图上限（PNG/JPEG/WebP 的字节数）。 */
export const AVIF_MAX_SOURCE_BYTES = 12 * 1024 * 1024

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]*)$/

export type AvifRequest = { buffer: Buffer; quality: number }

/** 质量 0–100 → AVIF 的 CRF（0 最好、63 最差）。 */
export function crfForQuality(quality: number): number {
  const q = Math.max(0, Math.min(100, Number.isFinite(quality) ? quality : 85))
  return Math.max(10, Math.min(55, Math.round(63 - q * 0.46)))
}

export function parseAvifRequest(raw: unknown): AvifRequest {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  if (typeof body.image !== 'string') {
    throw new HttpError('BAD_REQUEST', '没有收到要转换的图片。', 400)
  }
  const match = DATA_URL.exec(body.image)
  if (!match) {
    throw new HttpError('BAD_REQUEST', '只支持 PNG / JPG / WebP 转 AVIF。', 400)
  }
  const buffer = Buffer.from(match[2]!, 'base64')
  if (buffer.length === 0) {
    throw new HttpError('BAD_REQUEST', '这张图是空的。', 400)
  }
  if (buffer.length > AVIF_MAX_SOURCE_BYTES) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，先缩到 12MB 以内。', 413)
  }
  const quality = Number(body.quality ?? 85)
  if (!Number.isFinite(quality)) {
    throw new HttpError('BAD_REQUEST', '导出质量不对。', 400)
  }
  return { buffer, quality: Math.round(Math.max(0, Math.min(100, quality))) }
}

export function avifArgs(
  input: string, output: string, quality: number,
): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-i', input,
    '-frames:v', '1',
    '-c:v', 'libaom-av1',
    '-still-picture', '1',
    '-crf', String(crfForQuality(quality)),
    '-cpu-used', '6',
    '-row-mt', '1',
    '-pix_fmt', 'yuv420p',
    '-f', 'avif',
    output,
  ]
}

type Runner = (command: string, args: string[], timeout: number) => Promise<void>

const defaultRunner: Runner = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error) => {
      if (!error) {
        resolve()
        return
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new HttpError(
          'INTERNAL',
          '这台电脑没有安装 ffmpeg，暂时导不出 AVIF；换 JPG / WebP 导出。',
          503,
        ))
        return
      }
      reject(new HttpError('INTERNAL', 'AVIF 没转出来，换 JPG / WebP 导出。', 500))
    })
  })

export async function convertToAvif(
  raw: unknown, run: Runner = defaultRunner,
): Promise<Uint8Array> {
  const request = parseAvifRequest(raw)
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-avif-'))
  const input = join(dir, 'in.png')
  const output = join(dir, 'out.avif')
  try {
    await writeFile(input, request.buffer)
    await run('ffmpeg', avifArgs(input, output, request.quality), 60_000)
    const bytes = await readFile(output)
    if (bytes.length === 0) {
      throw new HttpError('INTERNAL', 'AVIF 转出来是空的，换 JPG / WebP 导出。', 500)
    }
    return new Uint8Array(bytes)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
