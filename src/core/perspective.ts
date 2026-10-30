/**
 * **四角自由透视**（★ 2026-10-17）的纯算式。
 *
 * 四个角按 左上 / 右上 / 右下 / 左下 排列，坐标归一化到原图。应用时把
 * 这个四边形映射成一块正矩形：四边形里的内容被"拉正"，输出尺寸取四角外接框。
 */
export type PerspectivePoint = { x: number; y: number }
export type PerspectiveQuad = [
  PerspectivePoint, PerspectivePoint, PerspectivePoint, PerspectivePoint,
]

export type ProjectiveCoefficients = {
  a: number; b: number; c: number
  d: number; e: number; f: number
  g: number; h: number
}

export function defaultPerspectiveQuad(): PerspectiveQuad {
  return [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ]
}

export function isIdentityPerspective(quad: PerspectiveQuad): boolean {
  const base = [[0, 0], [1, 0], [1, 1], [0, 1]] as const
  return quad.every((p, i) =>
    Math.abs(p.x - base[i]![0]) < 1e-6 && Math.abs(p.y - base[i]![1]) < 1e-6)
}

/** 移动一个角，并保证四个角的左右 / 上下次序不交叉。 */
export function movePerspectiveHandle(
  quad: PerspectiveQuad, index: 0 | 1 | 2 | 3, point: PerspectivePoint,
): PerspectiveQuad {
  const out = quad.map(p => ({ ...p })) as PerspectiveQuad
  const minGap = 0.02
  let x = Math.max(0, Math.min(1, Number.isFinite(point.x) ? point.x : 0))
  let y = Math.max(0, Math.min(1, Number.isFinite(point.y) ? point.y : 0))
  if (index === 0) {
    x = Math.min(x, out[1].x - minGap)
    y = Math.min(y, out[3].y - minGap)
  } else if (index === 1) {
    x = Math.max(x, out[0].x + minGap)
    y = Math.min(y, out[2].y - minGap)
  } else if (index === 2) {
    x = Math.max(x, out[3].x + minGap)
    y = Math.max(y, out[1].y + minGap)
  } else {
    x = Math.min(x, out[2].x - minGap)
    y = Math.max(y, out[0].y + minGap)
  }
  out[index] = {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  }
  return out
}

/** 四角在图片像素里的外接框；输出画布就用它的大小。 */
export function perspectiveBounds(
  quad: PerspectiveQuad, width: number, height: number,
): { x0: number; y0: number; x1: number; y1: number; width: number; height: number } {
  const px = quad.map(p => ({ x: Math.max(0, Math.min(1, p.x)) * width, y: Math.max(0, Math.min(1, p.y)) * height }))
  const x0 = Math.max(0, Math.floor(Math.min(...px.map(p => p.x))))
  const y0 = Math.max(0, Math.floor(Math.min(...px.map(p => p.y))))
  const x1 = Math.min(width, Math.ceil(Math.max(...px.map(p => p.x))))
  const y1 = Math.min(height, Math.ceil(Math.max(...px.map(p => p.y))))
  return {
    x0, y0, x1, y1,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  }
}

/**
 * 单位正方形 (0,0)~(1,1) → 四边形（像素坐标）的投影矩阵。
 * 对应点：TL(0,0)、TR(1,0)、BR(1,1)、BL(0,1)。
 */
export function squareToQuad(
  quad: PerspectiveQuad, width: number, height: number,
): ProjectiveCoefficients {
  const [p0, p1, p2, p3] = quad.map(p => ({ x: p.x * width, y: p.y * height }))
  const dx1 = p1!.x - p2!.x
  const dx2 = p3!.x - p2!.x
  const dx3 = p0!.x - p1!.x + p2!.x - p3!.x
  const dy1 = p1!.y - p2!.y
  const dy2 = p3!.y - p2!.y
  const dy3 = p0!.y - p1!.y + p2!.y - p3!.y
  const den = dx1 * dy2 - dx2 * dy1
  let g = 0
  let h = 0
  if ((Math.abs(dx3) > 1e-10 || Math.abs(dy3) > 1e-10) && Math.abs(den) > 1e-10) {
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
  }
  return {
    a: p1!.x - p0!.x + g * p1!.x,
    b: p3!.x - p0!.x + h * p3!.x,
    c: p0!.x,
    d: p1!.y - p0!.y + g * p1!.y,
    e: p3!.y - p0!.y + h * p3!.y,
    f: p0!.y,
    g,
    h,
  }
}

export function mapUnitSquare(
  m: ProjectiveCoefficients, u: number, v: number,
): { x: number; y: number } {
  const den = m.g * u + m.h * v + 1
  const safe = Math.abs(den) < 1e-10 ? 1e-10 : den
  return {
    x: (m.a * u + m.b * v + m.c) / safe,
    y: (m.d * u + m.e * v + m.f) / safe,
  }
}
