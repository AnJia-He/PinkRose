import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  convertImageFile, detectImageConverters, imageConverterArgs,
} from './imageConverter.ts'

describe('本机图片转换器探测', () => {
  it('RAW 转换器参数符合各 CLI 的直接输出约定', () => {
    expect(imageConverterArgs('rawtherapee', 'in.cr3', 'out.jpg'))
      .toEqual(['-q', '-Y', '-j92', '-o', 'out.jpg', '-c', 'in.cr3'])
    expect(imageConverterArgs('darktable', 'in.cr3', 'out.jpg'))
      .toEqual([
        'in.cr3', 'out.jpg', '--hq', 'true',
        '--apply-custom-presets', 'false',
      ])
    expect(imageConverterArgs('libraw', 'in.cr3', 'out.tiff'))
      .toEqual(['-T', '-q', '3', '-w', '-o', '1', '-Z', 'out.tiff', 'in.cr3'])
  })

  it('macOS 上发现 RawTherapee 和 sips 时，分别标明 RAW 与 HEIC / TIFF 能力', async () => {
    const probe = vi.fn(async (command: string) =>
      command === 'rawtherapee-cli' || command === 'sips')

    const found = await detectImageConverters({ platform: 'darwin', probe })

    expect(found.map(converter => converter.kind)).toEqual(['rawtherapee', 'sips'])
    expect(found[0]!.formats).toEqual(['raw'])
    expect(found[1]!.formats).toEqual(['heic', 'tiff'])
  })

  it('darktable 从 macOS App 安装、不在 PATH 里时也能找到', async () => {
    const app = '/Applications/darktable.app/Contents/MacOS/darktable-cli'
    const probe = vi.fn(async (command: string) => command === app)

    const found = await detectImageConverters({ platform: 'darwin', probe })

    expect(found).toMatchObject([{
      kind: 'darktable',
      command: app,
      formats: ['raw'],
    }])
  })

  it('LibRaw 只找到 dcraw_emu 时，必须配一个真实的 TIFF → JPEG 编码器', async () => {
    const probe = vi.fn(async (command: string) =>
      command === 'dcraw_emu' || command === 'sips')

    const found = await detectImageConverters({ platform: 'darwin', probe })

    expect(found).toMatchObject([
      {
        kind: 'libraw',
        command: 'dcraw_emu',
        formats: ['raw'],
        postprocess: { kind: 'sips', command: 'sips' },
      },
      { kind: 'sips', command: 'sips' },
    ])
  })

  it('Homebrew 的 /opt/homebrew/bin 不在 PATH 时，也能找到 LibRaw', async () => {
    const libraw = '/opt/homebrew/bin/dcraw_emu'
    const probe = vi.fn(async (command: string) =>
      command === libraw || command === 'sips')

    const found = await detectImageConverters({ platform: 'darwin', probe })

    expect(found).toMatchObject([
      { kind: 'libraw', command: libraw },
      { kind: 'sips', command: 'sips' },
    ])
  })

  it('LibRaw 先写 TIFF，再编成 JPEG，成功后才清掉中间文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pinkrose-libraw-test-'))
    const input = join(dir, 'camera.cr3')
    const output = join(dir, 'out.jpg')
    const calls: { command: string; args: string[] }[] = []
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === 'dcraw_emu') {
        const intermediate = args[args.indexOf('-Z') + 1]!
        await writeFile(intermediate, 'tiff-bytes')
      } else {
        await writeFile(args.at(-1)!, new Uint8Array([255, 216, 255, 217]))
      }
    })
    const converter = {
      kind: 'libraw' as const,
      command: 'dcraw_emu',
      args: (from: string, to: string) => imageConverterArgs('libraw', from, to),
      formats: ['raw'] as const,
      postprocess: {
        kind: 'sips' as const,
        command: 'sips',
        args: (from: string, to: string) => imageConverterArgs('sips', from, to),
      },
    }
    try {
      await writeFile(input, 'raw-bytes')
      await convertImageFile(converter, input, output, 120_000, run)

      const intermediateAt = calls[0]!.args.indexOf('-Z') + 1
      const intermediate = calls[0]!.args[intermediateAt]!
      expect(intermediate.endsWith('.tiff')).toBe(true)
      expect(existsSync(intermediate)).toBe(false)
      expect(calls.map(call => call.command)).toEqual(['dcraw_emu', 'sips'])
      expect([...await readFile(output)]).toEqual([255, 216, 255, 217])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
