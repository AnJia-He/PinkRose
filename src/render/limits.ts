import type { Size } from '../../shared/size.ts'

/**
 * 画布面积上限（总像素数），**只对 iOS 系生效**。
 *
 * iOS Safari 长期把 canvas 面积压在约 1670 万像素（16.7 MP），这条限制
 * GPU 不会通过 MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS 报出来，超了也不报错，
 * 而是**静默失败**：WebGL 画不出东西，用户拿到一块白画布，而保存按钮还会
 * 把这些白像素当成品导出去。真实的 iPhone 原图 4032×3024 ≈ 12.2 MP 已经
 * 贴在这条线上，48 MP 远超。
 *
 * 其他平台不套这个常量：桌面 Chrome/Firefox 渲染 2000 万像素以上的图没有
 * 问题，一刀切只会把它们无谓拒掉。那边按设备自报的 MAX_TEXTURE_SIZE /
 * MAX_VIEWPORT_DIMS 判就够了。
 */
export const MAX_CANVAS_AREA = 16777216

/**
 * 本设备画得动的尺寸上限。
 *
 * `maxSide` 是单边最大像素，`maxArea` 是总面积上限（null = 这个平台没有）。
 * 两条都可能被触发，且**互不蕴含**：iPhone 上一张 8000×6250 单边完全合格，
 * 面积却超了一倍。所以缩的时候两条都得判。
 */
export type RenderLimit = {
  maxSide: number
  maxArea: number | null
}

/**
 * 是不是 iOS 系浏览器。
 *
 * 除了 iPhone/iPad/iPod 的 UA，还要认 iPadOS 13+ 的「伪装成 Mac」：它的 UA
 * 与桌面 Safari 一模一样，只能靠「平台报 Mac 却支持多点触控」来区分。
 */
export function isIOS(): boolean {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true
  return navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform)
}

/** 从一个活的 GL 上下文问出本设备的上限。 */
export function readLimit(gl: WebGL2RenderingContext): RenderLimit {
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
  return {
    // 纹理上限和视口上限是两道独立的闸，取更小的那个
    maxSide: Math.min(maxTex, maxView[0], maxView[1]),
    maxArea: isIOS() ? MAX_CANVAS_AREA : null,
  }
}

/**
 * 问出本设备的上限，**不需要先有一个渲染管线**。
 *
 * 为什么要单独开一个临时上下文：上传照片发生在画布挂上之前（图还没有，
 * `Canvas` 就还没渲染，管线也就还不存在），而「要不要先缩一下」必须在
 * 把图交给画布之前就决定。所以这里开一个一次性的上下文问完就扔。
 *
 * 用完必须 `loseContext()`：浏览器的活上下文数量有上限（约 16 个），
 * 光靠 GC 回收会把用户的标签页拖垮。
 *
 * 拿不到上下文时返回 null —— 那说明这浏览器根本没有 WebGL2，
 * 真正的原因由渲染那一步去报（那条提示比这里更准确，见 Canvas.tsx 的 fail）。
 */
export function probeLimit(): RenderLimit | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) return null
  try {
    return readLimit(gl)
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

/**
 * 把 w×h 缩到限内。**只缩不放**，本来就在限内就原样返回。
 *
 * 三条要守住的东西：
 *
 * 1. **不顺手缩**。在限内就一个像素都不动 —— 缩一次是永久的画质损失，
 *    而绝大多数照片根本不需要。
 * 2. **取整绝不往上顶**。这里用 Math.floor 而不是 Math.round：按面积算出的
 *    3549.9…×4725.7… 用 round 会变成 3550×4726 = 16,777,300，比 16777216
 *    的上限**还大 84 像素**。于是渲染照样静默失败，而我们刚在上面保证过
 *    「缩了就没事了」。floor 在数学上保证不会超（floor(x) ≤ x，逐项缩只会更小），
 *    代价是最多多缩 1 像素 —— 那个代价是零。
 * 3. **短边最少留 1 像素**。极端长条图（10000×1）缩完短边会变成 0.4，
 *    画布高 0 会直接抛错。
 *
 * 调用方拿到比上限小的结果时别去"补"——那 1 像素是故意留的余量。
 */
export function fitToLimit(w: number, h: number, limit: RenderLimit): Size {
  let k = 1
  const longest = Math.max(w, h)
  if (longest > limit.maxSide) k = limit.maxSide / longest

  // 面积这条要拿**缩过之后的**面积再判一次：单边缩完仍然可能超过面积上限。
  // 真超了就直接按面积重算 k —— sqrt 那一路必然比 k 小（见上面的理由），
  // 所以重算之后单边那条自动还是满足的，不用回头再判。
  if (limit.maxArea !== null && w * h * k * k > limit.maxArea) {
    k = Math.sqrt(limit.maxArea / (w * h))
  }

  if (k >= 1) return { width: w, height: h }
  return {
    width: Math.max(1, Math.floor(w * k)),
    height: Math.max(1, Math.floor(h * k)),
  }
}
