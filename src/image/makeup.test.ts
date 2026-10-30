import { describe, expect, it } from 'vitest'
import { makeupPixels } from './makeup'
import type { FaceBox } from '../core/faceDetect'

const W = 200
const H = 200
const FACE: FaceBox = { x: 40, y: 30, w: 120, h: 150, confidence: 1 }

function image(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  const cx = FACE.x + FACE.w / 2
  const cy = FACE.y + FACE.h / 2
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const skin = Math.hypot((x - cx) / 60, (y - cy) / 75) < 1
      data[i] = skin ? 210 : 40
      data[i + 1] = skin ? 170 : 50
      data[i + 2] = skin ? 150 : 60
      data[i + 3] = 255
    }
  }
  const lipCx = FACE.x + FACE.w * 0.5
  const lipCy = FACE.y + FACE.h * 0.78
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot((x - lipCx) / 24, (y - lipCy) / 10) >= 1) continue
      const i = (y * W + x) * 4
      data[i] = 180
      data[i + 1] = 60
      data[i + 2] = 70
    }
  }
  // 中间一小块白牙：唇部椭圆里最亮、最低饱和的那块必须不被染色。
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot((x - lipCx) / 12, (y - lipCy) / 3.5) >= 1) continue
      const i = (y * W + x) * 4
      data[i] = 245
      data[i + 1] = 245
      data[i + 2] = 240
    }
  }
  return data
}

const px = (data: Uint8ClampedArray, x: number, y: number) => {
  const i = (y * W + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const
}

describe('makeupPixels（口红 / 腮红）', () => {
  it('强度 0 = 一个字节都不动', () => {
    const data = image()
    const before = data.slice()
    const r = makeupPixels(data, W, H, FACE, { lip: 0, blush: 0 })
    expect(r.changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('口红只染嘴唇：背景和牙齿不动，alpha 不变', () => {
    const data = image()
    const before = data.slice()
    const r = makeupPixels(data, W, H, FACE, { lip: 80, lipShade: 'rose' })
    expect(r.changed).toBeGreaterThan(0)
    // 避开牙齿的唇面像素变了
    expect(px(data, 100, 140)).not.toEqual(px(before, 100, 140))
    // 牙齿（唇形椭圆里那块亮白）一个字节都不动
    expect(px(data, 100, 147)).toEqual(px(before, 100, 147))
    // 背景不动
    expect(px(data, 2, 2)).toEqual(px(before, 2, 2))
    // alpha 永远不动
    expect(px(data, 100, 140)[3]).toBe(255)
  })

  it('腮红只染两颊：额头和背景不动', () => {
    const data = image()
    const before = data.slice()
    const cheek = [76, 123] as const
    const forehead = [100, 60] as const
    makeupPixels(data, W, H, FACE, { blush: 80 })
    const beforeCheek = px(before, cheek[0], cheek[1])
    const afterCheek = px(data, cheek[0], cheek[1])
    expect(afterCheek).not.toEqual(beforeCheek)
    expect(afterCheek[0] - afterCheek[1]).toBeGreaterThan(beforeCheek[0] - beforeCheek[1])
    expect(px(data, forehead[0], forehead[1])).toEqual(px(before, forehead[0], forehead[1]))
    expect(px(data, 2, 2)).toEqual(px(before, 2, 2))
  })

  it('不同口红色号给不同结果', () => {
    const coral = image()
    const berry = image()
    makeupPixels(coral, W, H, FACE, { lip: 80, lipShade: 'coral' })
    makeupPixels(berry, W, H, FACE, { lip: 80, lipShade: 'berry' })
    expect(px(coral, 100, 140)).not.toEqual(px(berry, 100, 140))
    const coralPx = px(coral, 100, 140)
    const berryPx = px(berry, 100, 140)
    expect(coralPx[0] - coralPx[1]).toBeGreaterThan(berryPx[0] - berryPx[1])
  })

  it('脸框完全在画面外 → 不崩、也不改像素', () => {
    const data = image()
    const before = data.slice()
    const r = makeupPixels(data, W, H, { x: -500, y: -500, w: 50, h: 50, confidence: 1 }, {
      lip: 100, blush: 100,
    })
    expect(r.changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })
})
