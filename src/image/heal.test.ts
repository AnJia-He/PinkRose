import { describe, expect, it } from 'vitest'
import { spotHeal } from './heal'

/**
 * 修补笔引擎的行为约定（移植自 Compositor 的 HealPixels.c，见 `heal.ts` 文件头）。
 *
 * 这些断言都建立在**手推的期望值**上（渐变图是调和解、条纹图有强纹理），
 * 不是把实现抄一遍 —— 详见各条注释。
 */

/** 横向线性渐变：r = 4x（60 宽 → 最大 240），g/b 恒定，全不透明。 */
function gradient(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      d[i] = x * 4
      d[i + 1] = 100
      d[i + 2] = 200
      d[i + 3] = 255
    }
  }
  return d
}

/** 竖条纹（周期 6，亮暗各半），中间先糊一块纯灰当"要擦的脏东西"。 */
function stripes(w: number, h: number, blob: { x0: number; y0: number; x1: number; y1: number }) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x % 6 < 3 ? 10 : 240
      const i = (y * w + x) * 4
      d[i] = d[i + 1] = d[i + 2] = v
      d[i + 3] = 255
    }
  }
  for (let y = blob.y0; y < blob.y1; y++) {
    for (let x = blob.x0; x < blob.x1; x++) {
      const i = (y * w + x) * 4
      d[i] = d[i + 1] = d[i + 2] = 128
    }
  }
  return d
}

function maskOf(w: number, h: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  const m = new Uint8Array(w * h)
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) m[y * w + x] = 255
  }
  return m
}

const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [d[i], d[i + 1], d[i + 2], d[i + 3]] as const
}

describe('spotHeal', () => {
  it('掩码外一个字节都不动（coverage = 0 的像素必须逐字节原样）', () => {
    const w = 60, h = 40
    const d = gradient(w, h)
    const before = new Uint8ClampedArray(d)
    const m = maskOf(w, h, { x0: 20, y0: 12, x1: 32, y1: 24 })

    spotHeal(d, w, h, m)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) continue
        const i = (y * w + x) * 4
        for (let c = 0; c < 4; c++) {
          if (d[i + c] !== before[i + c]) {
            throw new Error(`掩码外 (${x},${y}) 第 ${c} 通道被改了：${before[i + c]} → ${d[i + c]}`)
          }
        }
      }
    }
  })

  it('空掩码 = 什么都没发生（一个字节不动、healed 0、usedSource false）', () => {
    const w = 30, h = 20
    const d = gradient(w, h)
    const before = new Uint8ClampedArray(d)
    const res = spotHeal(d, w, h, new Uint8Array(w * h))
    expect(res).toEqual({ healed: 0, usedSource: false })
    expect([...d]).toEqual([...before])
  })

  it('★ 接缝连续性：线性渐变上擦一块，补回来还是一条一模一样的渐变', () => {
    // 为什么手算得出来：渐变是**调和解**，donor 补丁就是同一张渐变平移 (Δx,Δy)；
    // 光环上的差值恒为 -4·Δx，膜求解把常数铺满全洞 → 恰好抵消。
    // 结论：每个被擦像素 r 必须 ≈ 4x（±2 是 uint8 取整的余地）。
    // ⚠️ 这条同时看守"donor 不许压到洞上"：真压上了，常数差值的前提就没了，
    //    结果会花成一片，这里当场红。
    const w = 60, h = 40
    const d = gradient(w, h)
    const m = maskOf(w, h, { x0: 22, y0: 14, x1: 38, y1: 26 })

    const res = spotHeal(d, w, h, m)

    expect(res.healed).toBe(16 * 12)
    expect(res.usedSource).toBe(true)
    for (let y = 14; y < 26; y++) {
      for (let x = 22; x < 38; x++) {
        const [r, g, b] = px(d, w, x, y)
        expect(Math.abs(r! - x * 4)).toBeLessThanOrEqual(2)
        expect(g).toBe(100)
        expect(b).toBe(200)
      }
    }
  })

  it('★ 纹理搬运：把糊掉的条纹区域还原成条纹（亮度两极 + 均值对得上）', () => {
    const w = 60, h = 40
    const d = stripes(w, h, { x0: 24, y0: 16, x1: 36, y1: 28 })
    const m = maskOf(w, h, { x0: 24, y0: 16, x1: 36, y1: 28 })

    const res = spotHeal(d, w, h, m)

    expect(res.usedSource).toBe(true)
    let extreme = 0, sum = 0
    for (let y = 16; y < 28; y++) {
      for (let x = 24; x < 36; x++) {
        const [r] = px(d, w, x, y)
        sum += r!
        if (r! < 80 || r! > 180) extreme++
      }
    }
    // 原来的纯灰 128 既不是"暗"也不是"亮" —— 补完还全是 128 的话这条红。
    expect(extreme).toBeGreaterThanOrEqual(Math.round(12 * 12 * 0.8))
    // 条纹均值 ≈ (10+240)/2 = 125；糊成一片会让均值明显偏（比如全 128 也会红）
    expect(Math.abs(sum / (12 * 12) - 125)).toBeLessThan(25)
  })

  it('opacity = 0.5：结果恰好在原值和全强度之间各取一半（±2 取整）', () => {
    const w = 60, h = 40
    const base = gradient(w, h)
    const m = maskOf(w, h, { x0: 22, y0: 14, x1: 38, y1: 26 })

    const full = new Uint8ClampedArray(base)
    spotHeal(full, w, h, m)
    const half = new Uint8ClampedArray(base)
    spotHeal(half, w, h, m, { opacity: 0.5 })

    for (let y = 14; y < 26; y++) {
      for (let x = 22; x < 38; x++) {
        const [f] = px(full, w, x, y)
        const [hh] = px(half, w, x, y)
        const orig = x * 4
        expect(Math.abs(hh! - (orig + (f! - orig) / 2))).toBeLessThanOrEqual(2)
      }
    }
  })

  it('mode 1（生成纹理）：不找 donor（usedSource false），但仍然把洞补上了', () => {
    const w = 60, h = 40
    const d = gradient(w, h)
    // ⚠️ 洞里先塞一块**黑**再擦。不能在"本来就是渐变的洞"上验它 ——
    //    平滑填充是调和解，在线性渐变上解出来恰好就是渐变本身，改没改看不出来
    //    （这条断言踩过，绿得毫无意义）。
    for (let y = 14; y < 26; y++) {
      for (let x = 22; x < 38; x++) {
        const i = (y * w + x) * 4
        d[i] = d[i + 1] = d[i + 2] = 0
      }
    }
    const m = maskOf(w, h, { x0: 22, y0: 14, x1: 38, y1: 26 })

    const res = spotHeal(d, w, h, m, { mode: 1 })

    expect(res.usedSource).toBe(false)
    expect(res.healed).toBe(16 * 12)
    // 黑块必须被盖掉：逐个像素只在"不是黑"这个量级上验 ——
    // ⚠️ **不能逐像素卡紧公差**：mode 1 的"生成纹理"会**按 ring 的局部细节强度回填
    //    噪点**，而洞里那块黑把 ring 的细节强度顶得很高（原版行为，不是 bug）。
    //    均匀性要靠**平均偏差**验（噪点是零均值的）。
    let bright = 0
    let devSum = 0
    for (let y = 14; y < 26; y++) {
      for (let x = 22; x < 38; x++) {
        const [r] = px(d, w, x, y)
        if (r! > 40) bright++
        devSum += Math.abs(r! - x * 4)
      }
    }
    // 允许极个别像素落在阈值外（噪点零均值、尾部会有离群），绝不是"还原样一块黑"
    expect(bright).toBeGreaterThanOrEqual(184)
    expect(devSum / (16 * 12)).toBeLessThan(20)
  })

  it('掩码贴着画面角也安全：不抛错、掩码外不动、洞照样补上', () => {
    const w = 40, h = 30
    const d = gradient(w, h)
    const before = new Uint8ClampedArray(d)
    const m = maskOf(w, h, { x0: 0, y0: 0, x1: 10, y1: 8 })

    const res = spotHeal(d, w, h, m)

    expect(res.healed).toBe(10 * 8)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) continue
        const i = (y * w + x) * 4
        for (let c = 0; c < 4; c++) expect(d[i + c]).toBe(before[i + c])
      }
    }
  })

  it('同一个 seed = 逐字节相同的结果（可复现）', () => {
    const w = 60, h = 40
    const a = gradient(w, h)
    const b = gradient(w, h)
    const m = maskOf(w, h, { x0: 22, y0: 14, x1: 38, y1: 26 })
    spotHeal(a, w, h, m, { seed: 7 })
    spotHeal(b, w, h, m, { seed: 7 })
    expect([...a]).toEqual([...b])
  })

  it('不透明照片上 alpha 保持 255（不许被算花）', () => {
    const w = 60, h = 40
    const d = gradient(w, h)
    const m = maskOf(w, h, { x0: 22, y0: 14, x1: 38, y1: 26 })
    spotHeal(d, w, h, m)
    for (let y = 14; y < 26; y++) {
      for (let x = 22; x < 38; x++) {
        expect(px(d, w, x, y)[3]).toBe(255)
      }
    }
  })
})
