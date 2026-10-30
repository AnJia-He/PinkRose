/**
 * 64 位差值哈希（dHash）。
 *
 * 输入固定为 9×8 灰度图：比较每一行相邻两个像素，左暗右亮记 1。
 * 缩略图和曝光的小变化不会改变大部分 bit，适合快速找连拍 / 相似构图；
 * 它不是内容识别，不承诺理解人物或场景。
 */
export const DHASH_WIDTH = 9
export const DHASH_HEIGHT = 8

export function dHashFromGray(gray: Uint8Array): string {
  if (gray.length !== DHASH_WIDTH * DHASH_HEIGHT) {
    throw new Error('感知哈希需要 9×8 灰度图')
  }
  let hash = 0n
  let bit = 0n
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      if (gray[y * DHASH_WIDTH + x]! < gray[y * DHASH_WIDTH + x + 1]!) {
        hash |= 1n << bit
      }
      bit++
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function popcount64(value: bigint): number {
  let count = 0
  while (value) {
    value &= value - 1n
    count++
  }
  return count
}

export function hashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) {
    throw new Error('感知哈希必须是 16 位十六进制')
  }
  return popcount64(BigInt(`0x${a}`) ^ BigInt(`0x${b}`))
}

/** 默认阈值 10：能容忍缩略图尺寸、曝光和轻微抖动，又不会把不同构图算成一组。 */
export function isSimilarHash(a: string, b: string, maxDistance = 10): boolean {
  return hashDistance(a, b) <= maxDistance
}
