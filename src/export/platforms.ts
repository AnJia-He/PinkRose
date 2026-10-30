import type { ExportAspect } from './save'

/**
 * 常用社交平台的一键尺寸（★ 2026-10-19）。
 *
 * 单张导出和批量处理共用这一张表：平台以后改尺寸，只改这里。
 * 平台预设只把格式 / 质量 / 长边 / 比例调到一套常用值，不锁定用户后续修改。
 */
export const PLATFORM_PRESETS = [
  { id: 'xiaohongshu', label: '小红书', aspect: '3:4', longEdge: 1080, qualityPct: 92 },
  { id: 'moments', label: '朋友圈', aspect: '1:1', longEdge: 1080, qualityPct: 92 },
  { id: 'weibo', label: '微博', aspect: '4:3', longEdge: 1080, qualityPct: 92 },
  { id: 'vertical', label: '竖屏视频', aspect: '9:16', longEdge: 1080, qualityPct: 92 },
] as const satisfies readonly {
  id: string
  label: string
  aspect: Exclude<ExportAspect, 'original'>
  longEdge: number
  qualityPct: number
}[]
