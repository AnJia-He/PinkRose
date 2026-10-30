// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import {
  PRESET_FILE_FORMAT, PRESET_FILE_VERSION, parsePresetFile, presetExportFilename,
  parsePresetXmp, presetXmpFilename, serializePresetXmp, serializePresets,
} from './presetFile.ts'

function fileBody(presets: unknown[]) {
  return JSON.stringify({
    format: PRESET_FILE_FORMAT,
    version: PRESET_FILE_VERSION,
    exportedAt: '2026-10-17T10:00:00.000Z',
    presets,
  })
}

describe('preset transfer file', () => {
  it('round-trips names and all params', () => {
    const text = serializePresets([
      { name: '旅行暖调', params: { ...ZERO, exposure: 20, temperature: 18 } },
      { name: '冷调', params: { ...ZERO, temperature: -24 } },
    ], new Date('2026-10-17T18:00:00'))
    const parsed = parsePresetFile(text)
    expect(parsed.map(p => p.name)).toEqual(['旅行暖调', '冷调'])
    expect(parsed[0]!.params.exposure).toBe(20)
    expect(parsed[1]!.params.temperature).toBe(-24)
    expect(presetExportFilename(new Date('2026-10-17T18:00:00')))
      .toBe('PinkRose-presets-20261017-1800.json')
    expect(presetXmpFilename(new Date('2026-10-17T18:00:00')))
      .toBe('PinkRose-look-20261017-1800.xmp')
  })

  it('fills missing params in older files with zero and strips unknown keys', () => {
    const parsed = parsePresetFile(fileBody([
      { name: '老预设', params: { exposure: 12, madeUpKey: 999 } },
    ]))
    expect(parsed[0]!.params.exposure).toBe(12)
    expect(parsed[0]!.params.skinSmooth).toBe(0)
    expect('madeUpKey' in parsed[0]!.params).toBe(false)
  })

  it('rejects wrong formats, empty names, and duplicate names', () => {
    expect(() => parsePresetFile('not json')).toThrow(/不是有效/)
    expect(() => parsePresetFile(JSON.stringify({ format: 'other', version: 1, presets: [] })))
      .toThrow(/格式或版本/)
    expect(() => parsePresetFile(fileBody([{ name: '  ', params: {} }]))).toThrow(/名字/)
    expect(() => parsePresetFile(fileBody([
      { name: '同名', params: {} },
      { name: ' 同名 ', params: {} },
    ]))).toThrow(/重复/)
  })

  it('rejects empty files and more than the current preset limit', () => {
    expect(() => parsePresetFile(fileBody([]))).toThrow(/没有预设/)
    expect(() => parsePresetFile(fileBody(
      Array.from({ length: 31 }, (_, i) => ({ name: `P${i}`, params: {} })),
    ))).toThrow(/最多导入/)
  })

  it('PinkRose XMP 保存全部参数，并能无损回读', () => {
    const text = serializePresetXmp('人像底片', {
      ...ZERO,
      exposure: 20,
      skinSmooth: 37,
      lensDistortion: -22,
      hslOrangeSat: 18,
    })
    expect(text).toContain('xmlns:pinkrose=')
    expect(text).toContain('crs:Exposure2012="1"')
    const parsed = parsePresetXmp(text, 'fallback')
    expect(parsed.name).toBe('人像底片')
    expect(parsed.params).toMatchObject({
      exposure: 20,
      skinSmooth: 37,
      lensDistortion: -22,
      hslOrangeSat: 18,
    })
  })

  it('★ 第三方 XMP 能读回增量色温 / 色调与黑白通道混色', () => {
    const text = `<?xpacket begin=""?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:RDF>
          <rdf:Description
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:IncrementalTemperature="-24"
            crs:IncrementalTint="18"
            crs:ConvertToGrayscale="True"
            crs:GrayMixerRed="35"
            crs:GrayMixerGreen="-20"
            crs:GrayMixerBlue="10" />
        </rdf:RDF>
      </x:xmpmeta>`
    const parsed = parsePresetXmp(text, '黑白预设')
    expect(parsed.params).toMatchObject({
      temperature: -24,
      tint: 18,
      bwAmount: 100,
      bwRed: 35,
      bwGreen: -20,
      bwBlue: 10,
    })
  })

  it('★ 满强度黑白导出标准 Lightroom 灰度字段；部分去色不冒充完全黑白', () => {
    const full = serializePresetXmp('电影黑白', {
      ...ZERO, tint: -12, bwAmount: 100, bwRed: 30, bwGreen: -15, bwBlue: 8,
    })
    expect(full).toContain('crs:IncrementalTemperature="0"')
    expect(full).toContain('crs:IncrementalTint="-12"')
    expect(full).toContain('crs:ConvertToGrayscale="True"')
    expect(full).toContain('crs:GrayMixerRed="30"')

    const partial = serializePresetXmp('低调黑白', { ...ZERO, bwAmount: 60 })
    expect(partial).not.toContain('crs:ConvertToGrayscale="True"')
    expect(partial).toContain('pinkrose:bwAmount="60"')
  })

  it('第三方 XMP 映射常用基础项，范围换算和缺省值正确', () => {
    const text = `<?xpacket begin=""?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:RDF>
          <rdf:Description
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:Exposure2012="1.5"
            crs:Contrast2012="12"
            crs:Highlights2012="-30"
            crs:Shadows2012="40"
            crs:Clarity2012="15"
            crs:Texture="8"
            crs:Dehaze="20"
            crs:Vibrance="11"
            crs:Saturation="-7"
            crs:SharpenAmount="60"
            crs:LuminanceSmoothing="25"
            crs:GrainAmount="13" />
        </rdf:RDF>
      </x:xmpmeta>`
    const parsed = parsePresetXmp(text, 'Lightroom 预设')
    expect(parsed.name).toBe('Lightroom 预设')
    expect(parsed.params).toMatchObject({
      exposure: 30,
      contrast: 12,
      highlights: -30,
      shadows: 40,
      clarity: 15,
      texture: 8,
      dehaze: 20,
      vibrance: 11,
      saturation: -7,
      sharpen: 40,
      noiseReduction: 25,
      grain: 13,
    })
    expect(parsed.params.skinSmooth).toBe(0)
  })

  it('乱 XMP / 没有任何可用调色项时明确拒绝', () => {
    expect(() => parsePresetXmp('<not-xmp />', '坏文件')).toThrow(/XMP/)
    expect(() => parsePresetXmp(`<?xpacket?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:RDF><rdf:Description /></rdf:RDF></x:xmpmeta>`, '空文件')).toThrow(/没有可识别的调色/)
  })
})
