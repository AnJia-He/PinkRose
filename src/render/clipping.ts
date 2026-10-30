/**
 * 从已经渲染好的 RGBA 小图生成查看用裁切 mask。
 * 0 = 正常，1 = 高光，2 = 阴影；高光优先于阴影。
 */
export function clippingMaskPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { mask: Uint8Array; width: number; height: number } {
  if (pixels.length !== width * height * 4) {
    throw new Error(`像素尺寸和裁切提示对不上（像素 ${pixels.length} 字节，提示 ${width}×${height}）`)
  }
  const mask = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!
    if (r >= 251 || g >= 251 || b >= 251) mask[p] = 1
    else if (r <= 4 && g <= 4 && b <= 4) mask[p] = 2
  }
  return { mask, width, height }
}
