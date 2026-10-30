import { describe, expect, it } from 'vitest'
import {
  DHASH_HEIGHT, DHASH_WIDTH, dHashFromGray, hashDistance, isSimilarHash,
} from './perceptualHash'

function gray(pattern: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(DHASH_WIDTH * DHASH_HEIGHT)
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH; x++) {
      data[y * DHASH_WIDTH + x] = pattern(x, y)
    }
  }
  return data
}

describe('perceptual hash', () => {
  it('相同缩略图距离为 0，反向明暗梯度是满距离', () => {
    const rising = dHashFromGray(gray(x => x * 20))
    const falling = dHashFromGray(gray(x => 255 - x * 20))
    expect(hashDistance(rising, rising)).toBe(0)
    expect(hashDistance(rising, falling)).toBe(64)
  })

  it('轻微亮度变化仍被判为相似，大幅结构变化会超过阈值', () => {
    const base = dHashFromGray(gray((x, y) => Math.round(20 + x * 22 + y * 3)))
    const shifted = dHashFromGray(gray((x, y) => Math.round(35 + x * 22 + y * 3)))
    const inverse = dHashFromGray(gray((x, y) => Math.round(240 - x * 22 - y * 3)))
    expect(hashDistance(base, shifted)).toBe(0)
    expect(isSimilarHash(base, shifted)).toBe(true)
    expect(isSimilarHash(base, inverse)).toBe(false)
  })

  it('拒绝尺寸不对或格式不对的哈希', () => {
    expect(() => dHashFromGray(new Uint8Array(10))).toThrow(/9×8/)
    expect(() => hashDistance('bad', 'bad')).toThrow(/16 位/)
  })
})
