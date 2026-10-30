/**
 * 本机图片转换器的唯一探测入口。
 *
 * 相机桥的 RAW / HEIC / TIFF 预览和普通上传的解码兜底必须用同一套参数，
 * 否则同一张照片会出现“相机桥能转、主上传不能转”的分叉。
 */
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'

export type ImageConverterKind =
  | 'sips' | 'magick' | 'rawtherapee' | 'darktable' | 'libraw'
export type ImageConverterFormat = 'raw' | 'heic' | 'tiff'

export type ImageConverter = {
  kind: ImageConverterKind
  command: string
  args: (input: string, output: string) => string[]
  formats?: readonly ImageConverterFormat[]
  /** LibRaw 先输出 TIFF，再由这个本机编码器完成 JPEG。 */
  postprocess?: Pick<ImageConverter, 'kind' | 'command' | 'args'>
}

export function imageConverterArgs(
  kind: ImageConverterKind, input: string, output: string,
): string[] {
  if (kind === 'sips') return ['-s', 'format', 'jpeg', input, '--out', output]
  if (kind === 'rawtherapee') {
    return ['-q', '-Y', '-j92', '-o', output, '-c', input]
  }
  if (kind === 'darktable') {
    return [input, output, '--hq', 'true', '--apply-custom-presets', 'false']
  }
  if (kind === 'libraw') {
    return ['-T', '-q', '3', '-w', '-o', '1', '-Z', output, input]
  }
  return [input, '-auto-orient', '-quality', '92', output]
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
}

export function runImageConverter(
  command: string, args: string[], timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function convertImageFile(
  converter: ImageConverter,
  input: string,
  output: string,
  timeout: number,
  run: typeof runImageConverter = runImageConverter,
): Promise<void> {
  if (!converter.postprocess) {
    await run(converter.command, converter.args(input, output), timeout)
    return
  }
  const intermediate = output.replace(/\.[^./\\]+$/, '.tiff')
  try {
    await run(converter.command, converter.args(input, intermediate), timeout)
    await run(
      converter.postprocess.command,
      converter.postprocess.args(intermediate, output),
      timeout,
    )
  } finally {
    await rm(intermediate, { force: true }).catch(() => {})
  }
}

type ConverterCandidate = {
  kind: ImageConverterKind
  commands: readonly string[]
  probe: readonly string[]
  formats: readonly ImageConverterFormat[]
}

type DetectOptions = {
  platform?: NodeJS.Platform
  probe?: (command: string, args: readonly string[]) => Promise<boolean>
}

const defaultProbe = async (command: string, args: readonly string[]): Promise<boolean> => {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout: 4_000 }, error => {
      if (!error) {
        resolve(true)
        return
      }
      // dcraw_emu 的 -h 会用退出码 1 打印帮助；只要命令真的启动过，就算已安装。
      // ENOENT / EACCES 等字符串错误码才是“不可执行”。
      resolve(typeof error.code === 'number' || !!error.signal)
    })
  })
}

/** 找本机可用的转换器，按“能直接处理 RAW”的优先级排列。 */
export async function detectImageConverters(
  options: DetectOptions = {},
): Promise<ImageConverter[]> {
  const platform = options.platform ?? process.platform
  const probe = options.probe ?? defaultProbe
  const directCandidates: readonly ConverterCandidate[] = [
    {
      kind: 'rawtherapee',
      commands: [
        'rawtherapee-cli',
        '/opt/homebrew/bin/rawtherapee-cli',
        '/usr/local/bin/rawtherapee-cli',
        '/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli',
      ],
      probe: ['-h'],
      formats: ['raw'],
    },
    {
      kind: 'darktable',
      commands: [
        'darktable-cli',
        '/opt/homebrew/bin/darktable-cli',
        '/usr/local/bin/darktable-cli',
        '/Applications/darktable.app/Contents/MacOS/darktable-cli',
      ],
      probe: ['--version'],
      formats: ['raw'],
    },
  ]
  const rasterCandidates: readonly ConverterCandidate[] = [
    ...(platform === 'darwin'
      ? [{
        kind: 'sips' as const,
        commands: ['sips'],
        probe: ['--help'],
        formats: ['heic', 'tiff'] as const,
      }]
      : []),
    {
      kind: 'magick',
      commands: ['magick'],
      probe: ['-version'],
      formats: ['heic', 'tiff'],
    },
  ]
  const firstAvailable = async (
    candidates: readonly ConverterCandidate[],
  ): Promise<ImageConverter[]> => {
    const found: ImageConverter[] = []
    for (const candidate of candidates) {
      for (const command of candidate.commands) {
        if (!await probe(command, candidate.probe).catch(() => false)) continue
        found.push({
          kind: candidate.kind,
          command,
          args: (input, output) => imageConverterArgs(candidate.kind, input, output),
          formats: candidate.formats,
        })
        break
      }
    }
    return found
  }

  const raw = await firstAvailable(directCandidates)
  const raster = await firstAvailable(rasterCandidates)
  const librawCandidate: ConverterCandidate = {
    kind: 'libraw',
    commands: [
      'dcraw_emu',
      '/opt/homebrew/bin/dcraw_emu',
      '/usr/local/bin/dcraw_emu',
    ],
    probe: ['-h'],
    formats: ['raw'],
  }
  const librawFound = (await firstAvailable([librawCandidate]))[0]
  let libraw: ImageConverter | null = null
  if (librawFound && raster[0]) {
    const postprocess = raster[0]
    libraw = {
      ...librawFound,
      postprocess: {
        kind: postprocess.kind,
        command: postprocess.command,
        args: postprocess.args,
      },
    }
  }
  return [...raw, ...(libraw ? [libraw] : []), ...raster]
}

/** 兼容旧调用方：返回优先级最高的一个转换器。 */
export async function detectImageConverter(): Promise<ImageConverter | null> {
  return (await detectImageConverters())[0] ?? null
}
