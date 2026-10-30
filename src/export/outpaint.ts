import type { ExportAspect } from './save'
import { expandCanvas, expandedSize } from './expand'

export type OutpaintAspect = Exclude<ExportAspect, 'original'>

export const OUTPAINT_ASPECTS: readonly OutpaintAspect[] = [
  '1:1', '4:5', '3:4', '9:16', '16:9',
]

export function outpaintPrompt(aspect: OutpaintAspect): string {
  return `Outpaint this image to fill the entire ${aspect} canvas. ` +
    'Keep the original central photo exactly as it is: same identity, pose, expression, ' +
    'colors, lighting and composition. Replace the blurred or mirrored guide border with ' +
    'a natural, photorealistic continuation of the scene, matching perspective and light ' +
    'at the seams. Do not crop, zoom or move the original content. ' +
    'Do not add text, logos, frames, borders or watermarks.'
}

export function outpaintReply(aspect: OutpaintAspect): string {
  return `扩好了，这一版是 ${aspect}。可以继续调色或直接导出。`
}

/** 送给模型的底图：先把原图放进目标比例，四周用镜像 / 虚化给出上下文。 */
export function makeOutpaintCanvas(
  source: CanvasImageSource & { width: number; height: number },
  aspect: OutpaintAspect,
): HTMLCanvasElement {
  return expandCanvas(source, aspect, 'mirror')
}

export function outpaintSize(
  width: number, height: number, aspect: OutpaintAspect,
): { width: number; height: number } {
  return expandedSize(width, height, aspect)
}
