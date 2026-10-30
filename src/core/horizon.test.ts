import { describe, expect, it } from 'vitest'
import { detectHorizonAngle } from './horizon'

/** RGBA 测试图：`shade(x, y)` 返回 0~255 的灰度。 */
function image(
  width: number,
  height: number,
  shade: (x: number, y: number) => number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = shade(x, y)
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return out
}

/** 上半暗、下半亮的地平线；`angleDeg > 0` = 向右下斜。 */
function horizon(width: number, height: number, angleDeg: number): Uint8ClampedArray {
  const slope = Math.tan((angleDeg * Math.PI) / 180)
  const mid = height / 2
  return image(width, height, (x, y) => (y < mid + slope * (x - width / 2) ? 64 : 208))
}

describe('detectHorizonAngle（自动水平）', () => {
  it('水平地平线 → 0°', () => {
    expect(detectHorizonAngle(horizon(240, 160, 0), 240, 160)).toBeCloseTo(0, 1)
  })

  it('向右下斜 5° → +5°（和 CropSpec.angle 同向）', () => {
    expect(detectHorizonAngle(horizon(240, 160, 5), 240, 160)).toBeCloseTo(5, 0)
  })

  it('向左下斜 7° → -7°', () => {
    expect(detectHorizonAngle(horizon(240, 160, -7), 240, 160)).toBeCloseTo(-7, 0)
  })

  it('只超出 ±15° 一点也能量到（15° 以内）', () => {
    expect(detectHorizonAngle(horizon(300, 200, 12), 300, 200)).toBeCloseTo(12, 0)
  })

  it('纯灰 / 纯噪点：没有可信的边 → null（不硬猜）', () => {
    expect(detectHorizonAngle(image(200, 140, () => 128), 200, 140)).toBeNull()
    let seed = 7
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 24)
    expect(detectHorizonAngle(image(200, 140, rand), 200, 140)).toBeNull()
  })

  it('只有竖线 → null（自动水平只找近水平边）', () => {
    const d = image(200, 140, (x) => (x % 24 < 2 ? 32 : 220))
    expect(detectHorizonAngle(d, 200, 140)).toBeNull()
  })

  it('45° 斜线 → null（超出 ±15°）', () => {
    const d = image(200, 140, (x, y) => (Math.abs(y - x * 0.7) < 2 ? 32 : 220))
    expect(detectHorizonAngle(d, 200, 140)).toBeNull()
  })

  it('尺寸 / 数据不合法时安全返回 null', () => {
    expect(detectHorizonAngle(new Uint8ClampedArray(0), 0, 0)).toBeNull()
    expect(detectHorizonAngle(new Uint8ClampedArray(12), 8, 8)).toBeNull()
  })
})
