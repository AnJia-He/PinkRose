import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AVIF_MAX_SOURCE_BYTES, avifArgs, convertToAvif, crfForQuality, parseAvifRequest,
} from './imageConvert.ts'

const png = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`

describe('AVIF 请求', () => {
  it('接受 PNG / JPG / WebP，质量夹在 0–100', () => {
    expect(parseAvifRequest({ image: png, quality: 88 }))
      .toMatchObject({ quality: 88 })
    const webp = `data:image/webp;base64,${Buffer.from('webp-bytes').toString('base64')}`
    expect(parseAvifRequest({ image: webp, quality: 88 }).buffer.toString()).toBe('webp-bytes')
    expect(parseAvifRequest({ image: png, quality: 140 }).quality).toBe(100)
    expect(parseAvifRequest({ image: png, quality: -1 }).quality).toBe(0)
  })

  it('拒绝非图片 / 空图 / 过大的图', () => {
    expect(() => parseAvifRequest({ image: 'data:text/plain;base64,AAAA' }))
      .toThrow(/只支持/)
    expect(() => parseAvifRequest({ image: 'data:image/png;base64,' }))
      .toThrow(/空的/)
    const big = `data:image/png;base64,${Buffer.alloc(AVIF_MAX_SOURCE_BYTES + 1).toString('base64')}`
    expect(() => parseAvifRequest({ image: big })).toThrow(/太大了/)
  })

  it('质量映射到 CRF：越低越小，且有上下限', () => {
    expect(crfForQuality(100)).toBe(17)
    expect(crfForQuality(80)).toBe(26)
    expect(crfForQuality(0)).toBe(55)
    expect(crfForQuality(200)).toBe(17)
  })
})

describe('AVIF 编码', () => {
  it('参数固定为 libaom-av1 静帧 + yuv420p + avif 容器', () => {
    const args = avifArgs('in.png', 'out.avif', 85)
    const line = args.join(' ')
    expect(line).toContain('libaom-av1')
    expect(line).toContain('-still-picture 1')
    expect(line).toContain('-crf 24')
    expect(line).toContain('-pix_fmt yuv420p')
    expect(line).toContain('-f avif')
    expect(args.at(-1)).toBe('out.avif')
  })

  it('转换后读回字节，并把临时目录删掉', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      await writeFile(args.at(-1)!, 'avif-bytes')
    })
    const bytes = await convertToAvif({ image: png, quality: 85 }, run)
    expect(Buffer.from(bytes).toString()).toBe('avif-bytes')
    expect(run).toHaveBeenCalledWith('ffmpeg', expect.any(Array), 60_000)
    const dir = argsDir(run.mock.calls[0]![1]!)
    const { existsSync } = await import('node:fs')
    expect(existsSync(dir)).toBe(false)
  })
})

function argsDir(args: string[]): string {
  const input = args[args.indexOf('-i') + 1]!
  return dirname(input)
}
