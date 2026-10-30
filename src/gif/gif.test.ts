import { describe, expect, it } from 'vitest'
import {
  encodeGifBytes, lzwEncode, medianCutPalette,
} from './gif.ts'

/** 只给测试用的最小 GIF LZW 解码器；用来确认编码结果真能被标准流程读回。 */
function decodeLzw(data: Uint8Array, minCodeSize = 8): Uint8Array {
  const payload: number[] = []
  for (let i = 0; i < data.length;) {
    const n = data[i++]!
    if (n === 0) break
    for (let j = 0; j < n; j++) payload.push(data[i + j]!)
    i += n
  }
  let bit = 0
  const readCode = (size: number) => {
    let code = 0
    for (let i = 0; i < size; i++) {
      code |= ((payload[bit >> 3]! >> (bit & 7)) & 1) << i
      bit++
    }
    return code
  }
  const clear = 1 << minCodeSize
  const end = clear + 1
  let codeSize = minCodeSize + 1
  let dict: number[][] = []
  const reset = () => {
    dict = Array.from({ length: 256 }, (_, i) => [i])
    dict[clear] = []
    dict[end] = []
    codeSize = minCodeSize + 1
  }
  reset()
  const out: number[] = []
  let prev: number[] | null = null
  if (readCode(codeSize) !== clear) throw new Error('missing clear code')
  for (;;) {
    const code = readCode(codeSize)
    if (code === clear) { reset(); prev = null; continue }
    if (code === end) break
    let entry: number[]
    if (code < dict.length) entry = dict[code]!
    else if (code === dict.length && prev) entry = [...prev, prev[0]!]
    else throw new Error(`bad code ${code} / ${dict.length}`)
    out.push(...entry)
    if (prev) {
      dict.push([...prev, entry[0]!])
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++
    }
    prev = entry
  }
  return Uint8Array.from(out)
}

describe('GIF encoder', () => {
  it('写出 GIF89a 头、全局调色板、循环块和帧控制块', () => {
    const palette = medianCutPalette([[240, 20, 30], [20, 220, 80], [30, 60, 240]], 8)
    expect(palette).toHaveLength(256 * 3)
    const frame1 = new Uint8Array([0, 1, 1, 2])
    const frame2 = new Uint8Array([2, 2, 1, 0])
    const bytes = encodeGifBytes(2, 2, palette, [frame1, frame2], 500, true)
    const text = Buffer.from(bytes).toString('latin1')
    expect(text.startsWith('GIF89a')).toBe(true)
    expect(text).toContain('NETSCAPE2.0')
    expect(bytes[6]! | (bytes[7]! << 8)).toBe(2)
    expect(bytes[8]! | (bytes[9]! << 8)).toBe(2)
    expect(bytes.at(-1)).toBe(0x3b)
    let frames = 0
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++
    }
    expect(frames).toBe(2)
  })

  it('不循环时不写 NETSCAPE 扩展', () => {
    const palette = medianCutPalette([[0, 0, 0]], 2)
    const bytes = encodeGifBytes(1, 1, palette, [new Uint8Array([0])], 100, false)
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('NETSCAPE2.0')
  })

  it('LZW 输出以子块长度开头、以 0 结束', () => {
    const packed = lzwEncode(new Uint8Array([0, 1, 2, 3, 2, 1, 0]))
    expect(packed.length).toBeGreaterThan(2)
    expect(packed.at(-1)).toBe(0)
    expect(packed[0]).toBeGreaterThan(0)
    expect(packed[0]).toBeLessThanOrEqual(255)
  })

  it('LZW 编码能被标准解码流程还原（含字典填满后的 clear）', () => {
    const pixels = new Uint8Array(9000)
    let seed = 1234567
    for (let i = 0; i < pixels.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      pixels[i] = seed & 0xff
    }
    expect([...decodeLzw(lzwEncode(pixels))]).toEqual([...pixels])
  })

  it('中位切分输出固定的 256 色表，空样本也能给出合法调色板', () => {
    expect(medianCutPalette([])).toHaveLength(256 * 3)
    const palette = medianCutPalette([[250, 250, 250], [5, 5, 5]], 4)
    expect(palette).toHaveLength(256 * 3)
    expect(palette[0]).toBeGreaterThan(0)
  })
})
