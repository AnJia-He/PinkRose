export type ModelStatus = {
  kind: 'chat' | 'image'
  active: boolean
  alias: string
  modelId: string
}

/** 只展示别名；没有别名也不把完整 modelId 当营销文案展示。 */
export function modelLabelOf(configs: readonly ModelStatus[]): string {
  const image = configs.find(item => item.kind === 'image' && item.active)
  if (!image) return '未单独配置（使用服务端默认）'
  return image.alias.trim() || '已配置图片模型'
}
