import { writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  convertImportBytesToJpeg,
  convertImportToJpeg,
  getImportCapability,
  parseImportRequest,
  type ImportConverter,
} from './importConvert.ts'

const dataUrl = (mime: string, text: string) =>
  `data:${mime};base64,${Buffer.from(text).toString('base64')}`

describe('普通导入的本机转换兜底', () => {
  it('能力查询按 RAW / HEIC / TIFF 分组，不暴露命令路径', async () => {
    const capability = await getImportCapability({
      converters: [
        {
          kind: 'rawtherapee', command: '/private/bin/rawtherapee-cli',
          formats: ['raw'], args: () => [],
        },
        {
          kind: 'sips', command: '/usr/bin/sips',
          formats: ['heic', 'tiff'], args: () => [],
        },
      ],
    })
    expect(capability).toEqual({
      raw: true,
      heic: true,
      tiff: true,
      converters: ['rawtherapee', 'sips'],
      maxBytes: 128 * 1024 * 1024,
    })
    expect(JSON.stringify(capability)).not.toContain('/private/bin')
  })

  it('accepts HEIC / RAW / TIFF with a human file name', () => {
    expect(parseImportRequest({
      image: dataUrl('image/heic', 'heic'),
      name: 'IMG_0001.HEIC',
    })).toMatchObject({ name: 'IMG_0001.HEIC' })
    expect(parseImportRequest({
      image: dataUrl('application/octet-stream', 'raw'),
      name: 'IMG_0002.CR3',
    })).toMatchObject({ name: 'IMG_0002.CR3' })
    expect(parseImportRequest({
      image: dataUrl('image/x-pentax-pef', 'raw'),
      name: 'IMGP0003.PEF',
    })).toMatchObject({ name: 'IMGP0003.PEF', ext: '.pef' })
  })

  it('does not upload ordinary JPEG through the fallback', () => {
    expect(() => parseImportRequest({
      image: dataUrl('image/jpeg', 'jpeg'),
      name: 'photo.JPG',
    })).toThrow(/HEIC|RAW|TIFF/)
  })

  it('runs the selected local converter and returns JPEG bytes', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, new Uint8Array([255, 216, 255, 217]))
    })
    const converter: ImportConverter = {
      kind: 'magick',
      command: 'magick',
      args: (input, output) => [input, '-auto-orient', '-quality', '92', output],
    }
    const bytes = await convertImportToJpeg(
      { image: dataUrl('image/heic', 'heic'), name: 'IMG_0001.HEIC' },
      { converter, run },
    )
    expect([...bytes]).toEqual([255, 216, 255, 217])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('magick')
  })

  it('二进制上传走同一套格式校验、转换器和 JPEG 校验', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const outputAt = args.indexOf('-o')
      await writeFile(
        outputAt >= 0 ? args[outputAt + 1]! : args.at(-1)!,
        new Uint8Array([255, 216, 255, 217]),
      )
    })
    const converter: ImportConverter = {
      kind: 'rawtherapee',
      command: 'rawtherapee-cli',
      formats: ['raw'],
      args: (input, output) => ['-q', '-Y', '-j92', '-o', output, '-c', input],
    }

    const bytes = await convertImportBytesToJpeg(
      Buffer.from('raw-bytes'),
      'IMGP0001.PEF',
      { converter, run },
    )

    expect([...bytes]).toEqual([255, 216, 255, 217])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('rawtherapee-cli')
  })

  it('HEIC 会选择支持 HEIC 的转换器，不会误用 RAW 专用工具', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'sips') {
        await writeFile(args.at(-1)!, new Uint8Array([255, 216, 255, 217]))
      }
    })
    const raw: ImportConverter = {
      kind: 'rawtherapee',
      command: 'rawtherapee-cli',
      formats: ['raw'],
      args: (input, output) => ['-q', '-Y', '-j92', '-o', output, '-c', input],
    }
    const heic: ImportConverter = {
      kind: 'sips',
      command: 'sips',
      formats: ['heic', 'tiff'],
      args: (input, output) => ['-s', 'format', 'jpeg', input, '--out', output],
    }

    await convertImportToJpeg(
      { image: dataUrl('image/heic', 'heic'), name: 'IMG_0001.HEIC' },
      { converters: [raw, heic], run },
    )

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('sips')
  })

  it('第一个 RAW 转换器失败时，会继续尝试下一个转换器', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'rawtherapee-cli') throw new Error('unsupported camera')
      await writeFile(args.at(-1)!, new Uint8Array([255, 216, 255, 217]))
    })
    const rawtherapee: ImportConverter = {
      kind: 'rawtherapee',
      command: 'rawtherapee-cli',
      formats: ['raw'],
      args: (input, output) => ['-q', '-Y', '-j92', '-o', output, '-c', input],
    }
    const darktable: ImportConverter = {
      kind: 'darktable',
      command: 'darktable-cli',
      formats: ['raw'],
      args: (input, output) => [input, output],
    }

    const bytes = await convertImportToJpeg(
      { image: dataUrl('image/x-canon-cr3', 'raw'), name: 'IMG_0002.CR3' },
      { converters: [rawtherapee, darktable], run },
    )

    expect([...bytes]).toEqual([255, 216, 255, 217])
    expect(run.mock.calls.map(call => call[0]))
      .toEqual(['rawtherapee-cli', 'darktable-cli'])
  })

  it('转换器写出非 JPEG 内容时不能冒充成功，要继续回退', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      const body = command === 'darktable-cli'
        ? 'not-a-jpeg'
        : new Uint8Array([255, 216, 255, 217])
      const outputAt = args.indexOf('-o')
      await writeFile(outputAt >= 0 ? args[outputAt + 1]! : args.at(-1)!, body)
    })
    const darktable: ImportConverter = {
      kind: 'darktable',
      command: 'darktable-cli',
      formats: ['raw'],
      args: (input, output) => [input, output],
    }
    const rawtherapee: ImportConverter = {
      kind: 'rawtherapee',
      command: 'rawtherapee-cli',
      formats: ['raw'],
      args: (input, output) => ['-q', '-Y', '-j92', '-o', output, '-c', input],
    }

    const bytes = await convertImportToJpeg(
      { image: dataUrl('image/x-nikon-nef', 'raw'), name: 'IMG_0003.NEF' },
      { converters: [darktable, rawtherapee], run },
    )

    expect([...bytes]).toEqual([255, 216, 255, 217])
    expect(run.mock.calls.map(call => call[0]))
      .toEqual(['darktable-cli', 'rawtherapee-cli'])
  })

  it('returns an actionable error when no converter is installed', async () => {
    await expect(convertImportToJpeg(
      { image: dataUrl('image/heic', 'heic'), name: 'IMG_0001.HEIC' },
      { converter: null },
    )).rejects.toThrow(/JPG/)
  })
})
