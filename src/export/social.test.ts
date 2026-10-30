import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from './save'
import { buildSocialExportZip } from './social'
import { PLATFORM_PRESETS } from './platforms'

describe('social export bundle', () => {
  it('一次生成四个平台 JPG，并沿用隐私和色彩设置', async () => {
    const render = vi.fn(async (_options: ExportOptions) =>
      new Blob(['jpeg'], { type: 'image/jpeg' }))
    const result = await buildSocialExportZip(
      new File(['source'], '旅行.JPG', { type: 'image/jpeg' }),
      {
        ...DEFAULT_EXPORT_OPTIONS,
        preserveMetadata: false,
        colorSpace: 'display-p3',
      },
      render,
      '海边',
    )

    expect(result.count).toBe(PLATFORM_PRESETS.length)
    expect(result.name).toBe('海边_社交尺寸.zip')
    expect(render).toHaveBeenCalledTimes(PLATFORM_PRESETS.length)
    expect(render.mock.calls.map(call => call[0].aspect))
      .toEqual(PLATFORM_PRESETS.map(preset => preset.aspect))
    for (const call of render.mock.calls) {
      expect(call[0]).toMatchObject({
        format: 'image/jpeg',
        longEdge: 1080,
        fit: 'crop',
        preserveMetadata: false,
        colorSpace: 'display-p3',
      })
    }

    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes)).toContain('海边-xiaohongshu.jpg')
    expect(result.blob.type).toBe('application/zip')
  })
})
