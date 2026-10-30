import { describe, it, expect } from 'vitest'
import { parseCube, lutNameOk, sameLutName, normalizeLutRef, MAX_LUT_SIZE } from './lut.ts'

/** 造一个 size 级、每格由 fn 决定的 .cube 文本。默认红变最快（x 最快）。 */
function cubeText(size: number, fn: (r: number, g: number, b: number) => [number, number, number]): string {
  const lines = [`# 测试用`, `LUT_3D_SIZE ${size}`]
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const v = fn(r / (size - 1), g / (size - 1), b / (size - 1))
        lines.push(`${v[0]} ${v[1]} ${v[2]}`)
      }
  return lines.join('\n')
}

describe('parseCube', () => {
  it('读一个 2 级的恒等表，红变最快', () => {
    const cube = parseCube(cubeText(2, (r, g, b) => [r, g, b]))
    expect(cube.size).toBe(2)
    expect(cube.rgba.length).toBe(2 * 2 * 2 * 4)
    // 第 0 格 = 黑，最后一格 = 白
    expect([...cube.rgba.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...cube.rgba.slice(-4)]).toEqual([255, 255, 255, 255])
    // 第 1 格（x 最快）= 红 —— 这一条钉的就是"红变最快"的方向
    expect(cube.rgba[4]).toBe(255)
    expect(cube.rgba[5]).toBe(0)
  })

  it('容忍注释、空行、CRLF、大小写关键字', () => {
    const text = `# 注释\r\n\r\nlut_3d_size 2\r\n` + '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
    expect(parseCube(text).size).toBe(2)
  })

  it('TITLE 带出来当默认名字', () => {
    const text = `TITLE "Portra 400"\n` + cubeText(2, (r, g, b) => [r, g, b]).split('\n').slice(1).join('\n')
    expect(parseCube(text).title).toBe('Portra 400')
  })

  it('DOMAIN_MIN/MAX 照收', () => {
    const text = `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n` +
      '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
    const cube = parseCube(text)
    expect(cube.domainMax).toEqual([2, 2, 2])
  })

  it('1D 三通道曲线展开成现有渲染链能直接用的 3D 表', () => {
    const cube = parseCube([
      'LUT_1D_SIZE 3',
      '0 0 0',
      '0.5 0.25 0.75',
      '1 1 1',
    ].join('\n'))
    expect(cube.size).toBe(3)
    const at = (r: number, g: number, b: number) => {
      const offset = ((b * cube.size + g) * cube.size + r) * 4
      return [...cube.rgba.slice(offset, offset + 4)]
    }
    expect(at(0, 0, 0)).toEqual([0, 0, 0, 255])
    expect(at(1, 1, 1)).toEqual([128, 64, 191, 255])
    expect(at(2, 0, 0)).toEqual([255, 0, 0, 255])
  })

  it('1D LUT 保留自己的 DOMAIN_MIN / MAX', () => {
    const cube = parseCube([
      'LUT_1D_SIZE 2',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 2 2 2',
      '0 0 0',
      '1 1 1',
    ].join('\n'))
    expect(cube.domainMax).toEqual([2, 2, 2])
  })

  it('级数超限拒绝，并说出那个数', () => {
    expect(() => parseCube(`LUT_3D_SIZE ${MAX_LUT_SIZE + 64}\n`)).toThrow(/64 级以内/)
  })

  it('行数不对 / 数值越界 / 乱文件 都拒绝', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/读不出来/)
    expect(() => parseCube(cubeText(2, () => [0, 0, 0]).replace('0 0 0', '9 0 0'))).toThrow(/读不出来/)
    expect(() => parseCube('hello world\n')).toThrow(/不是 \.cube/)
  })
})

describe('小工具', () => {
  it('名字 1–30 字', () => {
    expect(lutNameOk('黄昏')).toBe(true)
    expect(lutNameOk('   ')).toBe(false)
    expect(lutNameOk('x'.repeat(31))).toBe(false)
  })
  it('比名字忽略首尾空格和大小写', () => {
    expect(sameLutName(' Sunset ', 'sunset')).toBe(true)
    expect(sameLutName('黄昏', '黄昏 ')).toBe(true)
  })
  it('normalizeLutRef：形状不对回 null，amount 钳到 0–100', () => {
    expect(normalizeLutRef({ lutId: 3, amount: 250 })).toEqual({ lutId: 3, amount: 100 })
    expect(normalizeLutRef({ lutId: 3, amount: 0 })).toEqual({ lutId: 3, amount: 0 })
    expect(normalizeLutRef({ lutId: 0, amount: 50 })).toBeNull()
    expect(normalizeLutRef({ lutId: 3 })).toBeNull()
    expect(normalizeLutRef(null)).toBeNull()
  })
})
