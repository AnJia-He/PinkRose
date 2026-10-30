/** 画布颜色读数：显示用 RGB / HEX / HSL，不参与任何修图参数。 */
export type ColorReading = {
  rgb: [number, number, number]
  hex: string
  hsl: [number, number, number]
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)))
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(value => clampByte(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

export function rgbToHsl(rgb: readonly [number, number, number]): [number, number, number] {
  const r = clampByte(rgb[0]) / 255
  const g = clampByte(rgb[1]) / 255
  const b = clampByte(rgb[2]) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const l = (max + min) / 2
  if (delta === 0) return [0, 0, Math.round(l * 100)]
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h = (h * 60 + 360) % 360
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

export function colorReading(rgb: readonly [number, number, number]): ColorReading {
  const clean: [number, number, number] = [
    clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2]),
  ]
  return { rgb: clean, hex: rgbToHex(clean), hsl: rgbToHsl(clean) }
}
