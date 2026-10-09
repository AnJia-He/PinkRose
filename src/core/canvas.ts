/**
 * 开一张画布、拿到它的 2D 上下文 —— 全前端"把图搬到画布上"的第一步。
 *
 * ★ 2026-10-09 收口：`createElement('canvas')` + 定宽高 + `getContext('2d')` +
 *   拿不到就抛，这四行在 `image/` 和 `core/thumbnail.ts` 里抄了九遍
 *   （`toSrgbBitmap` / `resizeBitmap` / `cropToBitmap` / `eraseToBitmap` /
 *   `prepareForModel` / `markImage` / `samplePixels` / 缩略图两处）。
 *
 * ⚠️ **`colorSpace: 'srgb'` 不是可选项**（`image/sample.ts` 里记着为什么）：
 *   iPhone 的原图常是 Display P3，不指定的话读回来的数字是 P3 的，
 *   同一张照片在两种设备上会拟合出不同的调色参数。**上下文只有这一处开** ——
 *   要加选项就加在 `opts` 上，别在调用点另开一张（`willReadFrequently` 就是
 *   这么加上来的：`eraseToBitmap` 要读像素）。
 *
 * ⚠️ 拿不到上下文**必须抛**：静默返回一张空画布的话，用户看到的是
 *   "裁出来 / 擦出来就是黑的"，而一句错都不报（`crop.test.ts` / `erase.test.ts`
 *   各钉着一条）。`what` 接着那句话往下说，写"干不成什么"：
 *   `'裁剪不了'` / `'擦不了'` / `'做不了缩略图'`。
 */
export function makeCanvas(
  width: number, height: number, what: string,
  opts: { willReadFrequently?: boolean } = {},
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', ...opts })
  if (!ctx) throw new Error(`拿不到 2D 上下文，${what}`)
  return { canvas, ctx }
}
