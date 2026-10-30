import { writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  convertToHeic,
  detectHeicEncoder,
  heicEncoderArgs,
  parseHeicRequest,
} from './heicConvert.ts'

const dataUrl = (text: string) =>
  `data:image/jpeg;base64,${Buffer.from(text).toString('base64')}`

describe('HEIC encoder detection', () => {
  it('prefers the macOS system encoder', async () => {
    const probe = vi.fn(async (encoder: 'sips' | 'magick') => encoder === 'sips')
    await expect(detectHeicEncoder(probe)).resolves.toBe('sips')
    expect(probe.mock.calls.map(call => call[0])).toEqual(['sips'])
  })

  it('falls back to ImageMagick only when it reports HEIC support', async () => {
    const probe = vi.fn(async (encoder: 'sips' | 'magick') => encoder === 'magick')
    await expect(detectHeicEncoder(probe)).resolves.toBe('magick')
  })

  it('returns null when neither encoder is available', async () => {
    await expect(detectHeicEncoder(async () => false)).resolves.toBeNull()
  })
})

describe('HEIC conversion', () => {
  it('parses an image data URL and clamps quality', () => {
    expect(parseHeicRequest({ image: dataUrl('photo'), quality: 140 })).toMatchObject({
      quality: 100,
    })
  })

  it('builds sips arguments without a shell', () => {
    expect(heicEncoderArgs('sips', 'in.jpg', 'out.heic', 88)).toEqual([
      '-s', 'format', 'heic',
      '-s', 'formatOptions', '88',
      'in.jpg',
      '--out', 'out.heic',
    ])
  })

  it('builds ImageMagick arguments without a shell', () => {
    expect(heicEncoderArgs('magick', 'in.jpg', 'out.heic', 88)).toEqual([
      'in.jpg',
      '-quality', '88',
      'out.heic',
    ])
  })

  it('writes the converted bytes and removes the temporary directory', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, new Uint8Array([1, 2, 3, 4]))
    })
    const result = await convertToHeic(
      { image: dataUrl('photo'), quality: 90 },
      { encoder: 'sips', run },
    )
    expect([...result]).toEqual([1, 2, 3, 4])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('sips')
  })

  it('returns a user-facing error when no encoder is installed', async () => {
    await expect(convertToHeic(
      { image: dataUrl('photo'), quality: 90 },
      { encoder: null },
    )).rejects.toThrow(/HEIC/)
  })
})
