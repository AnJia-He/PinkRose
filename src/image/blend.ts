/**
 * 合成混合模式（★ 2026-10-19）。
 *
 * 双重曝光、贴纸 / 自定义图片、形状共用这一份名字和 Canvas 映射。
 * 以前这些字符串散在 `doubleExposure.ts` 里；现在多两个消费者，收成一份，
 * 免得「正片叠底」在一处叫 `multiply`、另一处叫 `darken`。
 */
import type { BlendMode } from '../../shared/blend.ts'
export { BLEND_MODES, isBlendMode, type BlendMode } from '../../shared/blend.ts'

export const BLEND_COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
}
