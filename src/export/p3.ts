/** sRGB 编辑结果的像素值换成 Display P3 数值；两者使用同一 sRGB 传输曲线。 */

const SRGB_TO_XYZ_D65 = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
] as const

const XYZ_D65_TO_P3 = [
  [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
] as const

const decode = (value: number): number => value <= 0.04045
  ? value / 12.92
  : ((value + 0.055) / 1.055) ** 2.4

const encode = (value: number): number => {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055
}

export function srgbToDisplayP3(r: number, g: number, b: number): [number, number, number] {
  const linear = [decode(r), decode(g), decode(b)] as const
  const xyz = SRGB_TO_XYZ_D65.map(row =>
    row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])
  return XYZ_D65_TO_P3.map(row =>
    encode(row[0] * xyz[0]! + row[1] * xyz[1]! + row[2] * xyz[2]!)) as [
      number, number, number,
    ]
}

/** 原地把 RGBA sRGB 字节换成 Display P3 字节；alpha 不动。 */
export function convertSrgbPixelsToDisplayP3(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const lr = decode(data[i]! / 255)
    const lg = decode(data[i + 1]! / 255)
    const lb = decode(data[i + 2]! / 255)
    const x = SRGB_TO_XYZ_D65[0][0] * lr + SRGB_TO_XYZ_D65[0][1] * lg
      + SRGB_TO_XYZ_D65[0][2] * lb
    const y = SRGB_TO_XYZ_D65[1][0] * lr + SRGB_TO_XYZ_D65[1][1] * lg
      + SRGB_TO_XYZ_D65[1][2] * lb
    const z = SRGB_TO_XYZ_D65[2][0] * lr + SRGB_TO_XYZ_D65[2][1] * lg
      + SRGB_TO_XYZ_D65[2][2] * lb
    data[i] = Math.round(encode(
      XYZ_D65_TO_P3[0][0] * x + XYZ_D65_TO_P3[0][1] * y + XYZ_D65_TO_P3[0][2] * z,
    ) * 255)
    data[i + 1] = Math.round(encode(
      XYZ_D65_TO_P3[1][0] * x + XYZ_D65_TO_P3[1][1] * y + XYZ_D65_TO_P3[1][2] * z,
    ) * 255)
    data[i + 2] = Math.round(encode(
      XYZ_D65_TO_P3[2][0] * x + XYZ_D65_TO_P3[2][1] * y + XYZ_D65_TO_P3[2][2] * z,
    ) * 255)
  }
}
