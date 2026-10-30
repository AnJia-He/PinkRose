/** 合成混合模式；双重曝光、贴纸、形状共用这一份。 */
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay'

export const BLEND_MODES: readonly { id: BlendMode; label: string }[] = [
  { id: 'normal', label: '正常' },
  { id: 'screen', label: '滤色' },
  { id: 'multiply', label: '正片叠底' },
  { id: 'overlay', label: '叠加' },
]

export const isBlendMode = (v: unknown): v is BlendMode =>
  v === 'normal' || v === 'screen' || v === 'multiply' || v === 'overlay'
